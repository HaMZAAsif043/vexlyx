# Backup System (F5.3)

> **Status:** 🟢 COMPLETED
> **Feature:** Full-system backup snapshots (projects, databases, mail, DNS) with a configurable daily schedule, retention, and per-item restore.

---

## What It Does

F5.3 adds a `/backups` page to the Vexlyx dashboard that:

- **Runs full-system snapshots** — every project's source tree, every database (via `pg_dump`/`mysqldump`), every mail domain's Maildir tree, and every domain's DNS records, bundled into one `<snapshotId>.tar.gz` archive.
- **Schedules automatically** — one configurable cron schedule (default `0 3 * * *`, daily at 3am), editable from the dashboard without a redeploy.
- **Retains a rotation** — keeps the most recent N daily snapshots plus M older ones spaced ~7 days apart, deleting the rest (both the DB row and the archive file).
- **Restores per item** — pick a single project, database, mail domain, or DNS zone out of any completed snapshot and restore just that target in place, behind a destructive-confirmation dialog. There is no all-or-nothing full-server restore.
- **Shows live progress** — Socket.io pushes backup/restore progress lines and completion status to the page in real time.

Out of scope for this pass: S3/MinIO remote storage (local disk only, under `BACKUPS_DIR`), and certificates/vacation responders/SFTP accounts/env vars (not included in the manifest).

Project restore stops the project's Compose stack before extracting files. The stop command verifies every container (including sidecars) is stopped; Docker listing or inspection failures abort the restore with `RESTORE_STOP_FAILED`. No files are extracted and no successful restore audit event is recorded on this path. Resolve the Docker error and retry. Projects without a recorded container can restore directly. Operators must avoid concurrent starts or deployments during restore; this check does not lock external Docker operations.

---

## Architecture

```
Browser (Backups page)
  │  REST (trigger/list/settings/restore) + Socket.io ("backups" room)
  ▼
apps/api/src/modules/backups/{routes,service,socket,schema}.ts
  │  BullMQ: daily job scheduler (upsertJobScheduler) + manual-trigger jobs
  │  Prisma: BackupSnapshot / BackupSettings rows, reads Project/Database/Domain
  │  spawn(python, backup_manager.py) — stdin/stdout JSON, one call per run
  ▼
system/python/backup_manager.py
  │  tar project dirs, pg_dump/mysqldump via docker exec, tar mail vhosts subtree
  ▼
Host filesystem: BACKUPS_DIR/<snapshotId>.tar.gz
Docker containers: vexlyx-postgres, vexlyx-mysql, vexlyx-dovecot (via docker exec)
```

DNS records are **not** archived by Python — Postgres is their source of truth, so the API embeds each domain's `DnsRecord[]` directly as JSON in the `BackupSnapshot.manifest` column. Restoring DNS is pure Prisma (delete + recreate records, then re-sync the CoreDNS zone file) — no archive extraction needed.

### Key Files

| File | Purpose |
|------|---------|
| `system/python/backup_manager.py` | Archives projects/dumps DBs/tars mail domains; extracts + restores a single item |
| `apps/api/src/modules/backups/service.ts` | Spawns Python script, gathers manifest inputs from Prisma, retention logic |
| `apps/api/src/modules/backups/socket.ts` | Socket.io subscribe/unsubscribe handlers for the `backups` room |
| `apps/api/src/modules/backups/routes.ts` | REST endpoints + BullMQ scheduler registration |
| `apps/api/prisma/schema.prisma` | `BackupSnapshot` and `BackupSettings` models |
| `apps/dashboard/src/hooks/useBackups.ts` | React hooks (list/trigger/delete/restore/settings, Socket.io progress) |
| `apps/dashboard/src/components/backups/` | All UI components |
| `apps/dashboard/src/app/(panel)/backups/page.tsx` | Next.js route |

---

## Python Script (`backup_manager.py`)

**Protocol:** Same as `database_manager.py`/`docker_manager.py` — JSON payload on stdin, JSON response on stdout, `{"log": "..."}` lines for progress.

```bash
# Test locally (adjust paths/credentials for your setup):
echo '{"command":"create_snapshot","snapshotId":"test1","backupsDir":"./workspaces/backups","projects":[],"databases":[],"mail":[],"dns":[]}' | python3 system/python/backup_manager.py
```

Database dumps and restores stream through Python's built-in `gzip` module (not the `gzip` CLI) so the script works the same on Windows dev machines and Linux hosts. Mail archiving reuses the `get_vhosts_dir()` candidate-path helper from `dovecot_manager.py`, and restore re-applies the same `chown 5000:5000` ownership fix used when mailboxes are created.

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/backups` | ✅ | List snapshots |
| `GET` | `/api/backups/:id` | ✅ | Snapshot detail, including manifest |
| `POST` | `/api/backups` | ✅ | Queue a manual backup (202 Accepted) |
| `DELETE` | `/api/backups/:id` | ✅ | Delete a snapshot (row + archive file) |
| `POST` | `/api/backups/:id/restore` | ✅ | Restore one item — body `{ itemType, itemId }` |
| `GET` | `/api/backups/settings` | ✅ | Current schedule/retention config |
| `PUT` | `/api/backups/settings` | ✅ | Update schedule/retention — re-schedules the BullMQ job immediately |

---

## Socket.io Events

| Direction | Event | Payload |
|-----------|-------|---------|
| Client → Server | `subscribe:backups` | — |
| Server → Client | `backup:progress` | `{ snapshotId, message }` |
| Server → Client | `backup:completed` | `{ snapshotId, status, error? }` |
| Server → Client | `restore:progress` | `{ snapshotId, itemType, itemId, message }` |
| Server → Client | `restore:completed` | `{ snapshotId, itemType, itemId, status, error? }` |
| Client → Server | `unsubscribe:backups` | — |

---

## Database

```sql
CREATE TABLE backup_snapshots (
  id            TEXT PRIMARY KEY,
  status        "BackupStatus" NOT NULL DEFAULT 'PENDING',
  trigger       "BackupTrigger" NOT NULL,
  archive_path  TEXT,
  size_bytes    BIGINT,
  manifest      JSONB,
  error         TEXT,
  started_at    TIMESTAMP DEFAULT NOW(),
  completed_at  TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ON backup_snapshots (status);
CREATE INDEX ON backup_snapshots (created_at);

CREATE TABLE backup_settings (
  id               TEXT PRIMARY KEY DEFAULT 'default',
  schedule_cron    TEXT NOT NULL DEFAULT '0 3 * * *',
  retention_daily  INTEGER NOT NULL DEFAULT 7,
  retention_weekly INTEGER NOT NULL DEFAULT 4,
  updated_at       TIMESTAMP
);
```

`backup_settings` is a singleton row (`id = "default"`) — the live source of truth for the schedule once created; `BACKUP_SCHEDULE_CRON`/`BACKUP_RETENTION_DAILY`/`BACKUP_RETENTION_WEEKLY` env vars are only first-boot defaults.

---

## Background Job (BullMQ)

Registered in `backupRoutes()` on startup, using the persisted schedule:

```ts
await backupQueue.upsertJobScheduler(
  "daily-backup",
  { pattern: settings.scheduleCron },   // e.g. "0 3 * * *"
  { name: "scheduled-backup", data: { trigger: "SCHEDULED" } },
);
```

`PUT /api/backups/settings` re-calls `upsertJobScheduler` with the new cron pattern, so editing the schedule takes effect immediately (no restart). Manual triggers add a one-off `manual-backup` job to the same queue/worker.

---

## Retention

`BackupService.applyRetention()` runs after every successful backup:

1. Keep the most recent `retentionDaily` completed snapshots.
2. From the remainder (oldest-first), keep up to `retentionWeekly` more, each at least 7 days older than the last one kept.
3. Delete everything else — both the `BackupSnapshot` row and its `.tar.gz` archive (via the Python script's `delete_archive` command).

---

## How to Test

Automated safety regressions (no running database or Docker required):

```bash
pnpm --filter @vexlyx/api test -- src/modules/backups/service.test.ts
python -m unittest discover -s tests -p test_restore_stop_safety.py
```

1. Start the dev stack: `pnpm dev`
2. Visit `http://localhost:3000/backups`
3. Click **Backup Now** → watch the snapshot go `PENDING` → `RUNNING` (with live progress lines) → `COMPLETED`
4. Click the eye icon → confirm the manifest lists your projects/databases/mail domains/DNS zones
5. Pick one item → **Restore** → confirm the destructive dialog → verify the target is actually overwritten (project files, DB rows, mailbox contents, or DNS records)
6. Edit the schedule/retention in the settings card → save → confirm no server restart was needed
7. Create several backdated `BackupSnapshot` rows beyond the retention counts and confirm `applyRetention()` deletes the right ones

---

## How to Extend

### Add S3/MinIO remote storage

1. Add an S3-compatible client dependency (confirm with the user per CLAUDE.md's no-new-deps rule)
2. After `create_snapshot` succeeds, upload the archive and record the remote path/bucket somewhere on `BackupSnapshot` (e.g. a new `remotePath` column)
3. Add a "download from remote before restore" step to `restoreItem()` when the archive isn't present locally

### Add certificates / vacation responders / SFTP accounts to the manifest

1. Extend the Prisma queries in `BackupService.runBackupJob()` to include the extra models
2. Extend `BackupManifestSchema` in `packages/shared/src/schemas/backups.ts` accordingly
3. For file-backed items (SFTP keys, etc.), add an `archive_path()`-style helper in `backup_manager.py`; for DB-only items (like DNS), embed them directly in the manifest the same way

### Support full-server (all-or-nothing) restore

Add a `POST /api/backups/:id/restore-all` route that iterates every manifest entry and calls the same per-item restore paths — the per-item building blocks in `BackupService` are already there.

---

## Troubleshooting

### "Backup script exited with code 2 and no output"

Exit code 2 with **zero** stdout means the Python interpreter died before any of `backup_manager.py`'s own code ran — its only intentional exit path is `sys.exit(1)` inside `fail()`, always preceded by a JSON line on stdout. This is almost always the OS-level "can't open file: No such file or directory" (errno 2) from either:

- A misresolved script path — `getBackupScriptPath()` in `service.ts` searches a few candidate paths relative to the compiled `dist/` output and falls back to guessing if none exist.
- A missing/wrong Python interpreter — `PYTHON_BIN` (see below) pointing at a binary that isn't installed.

As of F5.14, the rejected `BackupError` includes the captured stderr when present (`service.ts`'s `runBackupCommand()`), so the dashboard/API response shows the actual OS error instead of just "no output" — check that message first.

### PYTHON_BIN

The API spawns `system/python/*.py` scripts using `env.PYTHON_BIN` if set, otherwise `python` on Windows / `python3` elsewhere (see `apps/api/.env.example`). Only set `PYTHON_BIN` if that default isn't the right interpreter on your host — e.g. a virtualenv, or a distro that ships neither `python` nor `python3` under those exact names.

### Startup health check

On every API boot, `checkBackupScriptHealth()` (`backups/service.ts`) verifies `backup_manager.py` resolves to a real file and that the configured Python interpreter actually runs (`--version`). If either fails, the API logs a loud error (`Backup system misconfigured: ...`) at startup instead of only surfacing the problem the next time a scheduled or manual backup runs. This check is diagnostic only — it doesn't block the API from starting, since the rest of the panel doesn't depend on backups working.
