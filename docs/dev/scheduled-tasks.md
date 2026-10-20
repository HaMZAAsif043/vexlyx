# Scheduled Tasks (F5.28)

Users can run a command inside a project's container on a cron schedule — Laravel's `php artisan schedule:run`, WordPress's `wp-cron.php`, a nightly cleanup or report script — without an external cron service or shell access. Each task gets run history, a "Run now" button and failure emails, and runs never touch the host.

## Data model

One migration (`20261010000000_add_scheduled_tasks`):

- **`ScheduledTask`** — `projectId`/`userId` (both cascade on delete), `name`, `command`, `schedule` (5-field cron), `timeoutSeconds` (default 300, max 3600), `enabled`, `notifyOnFailure` (default true), `consecutiveFailures`, `lastRunAt`, `nextRunAt`.
- **`ScheduledTaskRun`** — `taskId` (cascade), `trigger` (`SCHEDULED` | `MANUAL`), `status` (`RUNNING` | `SUCCESS` | `FAILED` | `TIMEOUT` | `SKIPPED`), `exitCode`, `output` (capped at 64 KB), `startedAt`, `finishedAt`. Only the latest **50 runs per task** are kept; older rows are deleted after each new run — runs that are still `RUNNING` are never trimmed, so a long job cannot be deleted from under its own completion update.
- **`User.maxScheduledTasks`** — nullable quota, enforced through the same F5.20 machinery as every other quota (`assertUnderQuota` in `utils/quota.ts`, including the reseller pool/oversell checks) with F5.23 warning emails at 80% and 100% (`notifyQuotaThreshold`). It participates in reseller pooling exactly like projects/domains/databases/mailboxes. Tasks of a **soft-deleted project** are excluded from the count: the rows stay (the project row is kept) but the panel can no longer reach them, so counting them would let a deleted project block a slot — and a reseller pool slot — forever.

## How scheduling works

`scheduler.ts` keeps a module-level reference to the `scheduled-task-runner` BullMQ queue (mirroring `backups/scheduler.ts`) so other modules can re-arm schedules without a circular import:

- One BullMQ **job scheduler** per task, id `scheduled-task:<taskId>`, with the task's cron pattern and the F5.13 server timezone as `tz`.
- On API boot every enabled task is re-armed and its `nextRunAt` is refreshed from BullMQ's own computed next run (`getJobScheduler(id).next` — a single lookup by scheduler id, not a listing of every scheduler), so what the dashboard shows is what will actually fire — DST quirks included. Arming is **per task and failure-isolated**: one unschedulable row is logged and skipped (its `nextRunAt` cleared) instead of aborting API boot.
- The worker also refreshes `nextRunAt` from BullMQ **after every scheduled firing**, so the dashboard never keeps showing the run that just happened.
- Create/update/delete re-arm or remove the scheduler immediately, before the row is committed to that state: if BullMQ refuses a create/update the row is rolled back/reverted **and the previous schedule is re-armed in BullMQ**, so the saved row and Redis can never disagree (400 `INVALID_SCHEDULE` for a refused pattern, 500 `SCHEDULE_ARM_FAILED` for infrastructure failures); delete disarms first — a failure surfaces as an error instead of a deleted-but-still-firing task, and a delete that fails **after** disarming re-arms the surviving row (it must never be left enabled with no scheduler); a create rollback also disarms the scheduler, since the arm may have reached BullMQ before a later step failed. **Changing the server timezone** (`PUT /api/system/settings`) re-arms everything via `rescheduleAllTasks()`.
- Finished jobs are capped in Redis (`removeOnComplete`/`removeOnFail`, 100 each) — PostgreSQL already holds the run history.
- Missed runs while the API was down are **not back-filled** (documented behavior).

## How execution works

The worker (and "Run now") call `ScheduledTaskService.executeTask()`:

1. A **Redis lock** (`SET NX EX`, TTL = timeout + 30s) prevents overlapping runs; an overlapping run is recorded as `SKIPPED`, never as a failure. The lock is released with a compare-and-delete Lua script, so only the holder releases its own lock.
2. If the project has no running container the run is recorded as `SKIPPED` ("Project not running") — the task itself stays enabled and resumes on its next tick. A **deleted** project is handled the same way (`SKIPPED`, "Project deleted"): its tasks are disabled and unscheduled when the project is soft-deleted, the worker disables any straggler it still fires, and "Run now" returns 404.
3. The command runs through the Python system layer: `docker_manager.py`'s `exec` action runs `docker exec <container> sh -c "<command>"`. The command is passed as an argv element (never interpolated into a host shell), and the container resolved at run time is the project's **application** container (the `app` service — not the HTTP-facing one: for WordPress and no-build PHP that would be nginx, which has no PHP binary), so a redeploy that replaces the container doesn't break the task. Output is read in fixed 64 KB chunks — everything past the 64 KB cap is drained and discarded, never buffered — and the deadline stays armed until the command has actually stopped. On timeout the process tree is located **inside the container** by an exec-unique `VEXLYX_TASK_ID` environment marker (inherited by every child) and TERM/KILLed, then the local `docker exec` client is dropped; killing only the local client would mark the run TIMEOUT while the command kept running.
4. The run row is created as `RUNNING` and **updated in place** with the final status/exit code/output, so history never accumulates orphaned RUNNING entries. Manual ("Run now") execution is synchronous — the API responds with the finished run. Persisting the outcome happens *after* the command produced it: a database error while saving the run (or updating the streak) is logged/rethrown on its own and **never rewrites a successful run as `FAILED`** (nor triggers a false failure email).

Failure streaks: `consecutiveFailures` increments on `FAILED`/`TIMEOUT` (including spawn/infrastructure errors) and resets to 0 on `SUCCESS`. At exactly 3 consecutive failures one email (`scheduled_task_failed`, F5.23) goes to the **task's owner**, unless the task has `notifyOnFailure` off — once per streak, not per run.

## Guards and limits

Enforced in `packages/shared/src/schemas/scheduledTasks.ts` (rejected with `VALIDATION_ERROR` / 400):

- 5-field cron only — a 6-field (seconds) expression is rejected; minimum interval is one minute.
- Every field is range-checked with BullMQ's own rules (minute 0–59, hour 0–23, day 1–31, month 1–12, weekday 0–7), including `*`, steps (`*/5`) and ranges/lists (`0-30/10 9-17 * 1,7 1-5`). `99 99 99 99 99` is rejected *before* anything is written, so an invalid schedule can never be saved and then fail to arm.
- Command ≤ 2,000 characters; timeout 1–3,600 seconds; name ≤ 100 characters.

Authorization (in the service, not the routes): owners manage tasks of their own projects, admins everything, resellers the tasks of their **sub-accounts** — checked via the *owner's* `resellerId`, since a RESELLER's own `resellerId` is always null. Unauthenticated calls get 401 (`requireAuth` on every route); other users' tasks get 403. Create/update/delete/run-now are written to the audit log (`scheduled_task.*` actions, F5.18).

## API

All under `/api/projects/:id/scheduled-tasks`, authenticated:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | List the project's tasks |
| POST | `/` | Create (quota-enforced, schedules the job, returns `nextRunAt`) |
| GET | `/:taskId` | Task detail (404 if the task isn't part of this project) |
| PUT | `/:taskId` | Partial update; only provided fields change (no create-time defaults are injected), re-arms the scheduler when `schedule`/`enabled` change |
| DELETE | `/:taskId` | Delete + unschedule |
| POST | `/:taskId/run` | Run now (synchronous, audited) |
| GET | `/:taskId/runs?limit=` | Run history (limit 1–100, default 50) |

## UI

A "Scheduled Tasks" panel on the project detail page (`ScheduledTasksPanel.tsx`): list with an enable/disable switch, failure-streak badge, last/next run; a create/edit dialog with presets (every minute, every 5 minutes, hourly, daily, weekly) plus a custom cron field with a plain-English description (cronstrue, timezone-aware); "Run now"; a run-history dialog with output in the always-dark terminal style; skeleton loading, empty state with a CTA, confirmation before delete, and a refresh button with the standard spin animation. A failed list or run-history load is never shown as an empty state: it surfaces as a toast **and** an inline error with a Retry button. The blocking error/empty states only apply when nothing is cached — a failed *background* refresh keeps the cached list (and any open dialog with unsaved edits) mounted and shows the error as an inline banner.

**Presets for common stacks**: `php artisan schedule:run` every minute (Laravel) and `wp-cron.php` every 5 minutes (WordPress — the panel's docs recommend setting `DISABLE_WP_CRON` in the app). Both runtimes ship the needed binaries in the standard Vexlyx images; the commands themselves are just typed into the Command field.

## How to test

Unit/integration (Vitest, colocated):

- `service.test.ts` — execution happy path, overlap lock (SKIPPED), project-not-running (SKIPPED) and deleted-project (SKIPPED, no exec), failure-streak email at exactly 3 (and silence below it / with notify off), streak reset on success, TIMEOUT counting as a failure, run-history trimming (including never trimming a `RUNNING` row), post-run persistence failures never rewriting the command's real result, reseller/sub-account access, `QUOTA_EXCEEDED`.
- `routes.test.ts` — 401 on every endpoint when signed out, 403 for another user's project, owner and reseller access, cron/command validation (6-field, out-of-range and 4-field expressions rejected; stepped/ranged expressions accepted), audited creation, quota enforcement, cross-project task 404, `nextRunAt` read back through `getJobScheduler(id)` (no full scheduler listing), the update-rollback path reverting the row **and** re-arming the previous schedule in BullMQ, partial updates carrying only the provided fields, a failed delete re-arming the surviving row, and a create rollback disarming the scheduler.
- `schema.test.ts` — the update schema applies no create-time defaults to omitted fields (a pause must not reset `timeoutSeconds`/`notifyOnFailure`), while create still defaults them.
- `utils/quota.test.ts` — the `scheduledTask` quota participates in the F5.20 nominal-pool cap, and does not count tasks whose project was soft-deleted.
- `tests/test_scheduled_task_exec.py` (Python, run with `python tests/test_scheduled_task_exec.py`) — the `exec` action targets the application (`app`) container rather than the HTTP-facing one, and falls back to the HTTP-facing container only when the compose file declares no `app` service.

Manual (needs Docker + the dev stack): create `echo hello` on the every-minute preset for a running project → a SUCCESS run with output `hello` appears within a minute; a command that outlives its timeout → TIMEOUT; three failing runs → exactly one email to the owner; stop the project → SKIPPED, start it → resumes; restart the API → schedules and `nextRunAt` restored; change the server timezone → next-run times shift.

## How to extend

- **New task type** (e.g. fetch-URL tasks, out of scope for v1): add an execution branch in `executeTask()` and a trigger/status if needed — the scheduling, locking, history and notification machinery is type-agnostic.
- **Adding a preset**: append to `CRON_PRESETS` in `ScheduledTasksPanel.tsx`; verify the required binary exists in the runtime image first.
- **Per-task notification settings** (e.g. "notify every failure"): extend the model + the single call site in `updateStreak()`.
