import type { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

// ---------------------------------------------------------------------------
// Module-level singleton so other modules (system/routes.ts, on a timezone
// change per F5.13) can re-upsert every task scheduler without a circular
// import back into scheduled-tasks/routes.ts. Mirrors backups/scheduler.ts.
// ---------------------------------------------------------------------------

export const SCHEDULED_TASK_QUEUE_NAME = "scheduled-task-runner";
export const SCHEDULED_TASK_PREFIX = "scheduled-task:";

let _queue: Queue | null = null;

export function registerScheduledTaskQueue(queue: Queue): void {
  _queue = queue;
}

export function getScheduledTaskQueue(): Queue | null {
  return _queue;
}

function schedulerId(taskId: string): string {
  return `${SCHEDULED_TASK_PREFIX}${taskId}`;
}

async function nextRunFor(queue: Queue, taskId: string): Promise<Date | null> {
  // Look the scheduler up by its own id — one HGET against `repeat:<id>`
  // instead of paging the whole scheduler zset on every scheduled run and
  // once per task at boot/timezone change (which is O(N²) over N tasks).
  const scheduler = await queue.getJobScheduler(schedulerId(taskId));
  return scheduler?.next ? new Date(scheduler.next) : null;
}

/**
 * Upserts the task's BullMQ job scheduler and returns the next run time
 * (read back from BullMQ so DST/`tz` handling matches what will actually
 * fire), or null when the pattern is invalid.
 */
export async function scheduleTaskJob(
  queue: Queue,
  taskId: string,
  cron: string,
  tz: string,
): Promise<Date | null> {
  await queue.upsertJobScheduler(
    schedulerId(taskId),
    { pattern: cron, tz },
    {
      name: `scheduled-task:${taskId}`,
      data: { taskId, trigger: "SCHEDULED" },
      // Bounded retention: repeatable jobs accumulate one row per firing, and
      // the run history is already persisted in PostgreSQL.
      opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    },
  );
  return nextRunFor(queue, taskId);
}

/**
 * Removes the task's BullMQ scheduler. Failures are logged and rethrown so a
 * delete/disable never reports success while a job is still armed
 * (CLAUDE.md: never swallow errors).
 */
export async function unscheduleTaskJob(
  queue: Queue,
  taskId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await queue.removeJobScheduler(schedulerId(taskId));
  } catch (err) {
    logger.error({ err, taskId }, "Failed to remove scheduled task job");
    throw err;
  }
}

/**
 * Re-reads BullMQ's next firing for a task and persists it, so `nextRunAt`
 * does not go stale after a scheduled run fires.
 */
export async function refreshNextRunAt(
  prisma: PrismaClient,
  queue: Queue,
  taskId: string,
  logger: FastifyBaseLogger,
): Promise<Date | null> {
  try {
    const next = await nextRunFor(queue, taskId);
    await prisma.scheduledTask.update({
      where: { id: taskId },
      data: { nextRunAt: next },
    });
    return next;
  } catch (err) {
    logger.error({ err, taskId }, "Failed to refresh scheduled task nextRunAt");
    return null;
  }
}

/**
 * Applies a task's current `enabled`/`schedule` state to BullMQ and persists
 * the result to `nextRunAt` so the dashboard can show it. Used by
 * create/update routes. Throws when BullMQ refuses to arm the schedule so the
 * caller can roll the persisted row back.
 */
export async function applyTaskSchedule(
  queue: Queue,
  prisma: PrismaClient,
  task: { id: string; schedule: string; enabled: boolean },
  tz: string,
  logger: FastifyBaseLogger,
): Promise<Date | null> {
  if (!task.enabled) {
    await unscheduleTaskJob(queue, task.id, logger);
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: null },
    });
    return null;
  }

  const next = await scheduleTaskJob(queue, task.id, task.schedule, tz);
  await prisma.scheduledTask.update({
    where: { id: task.id },
    data: { nextRunAt: next },
  });
  return next;
}

/**
 * Re-arms every enabled task's scheduler and refreshes each `nextRunAt`.
 * Called at API boot and from system/routes.ts when the server timezone
 * changes (F5.13). Missed runs while the API was down are not back-filled.
 *
 * Each task is armed independently: one bad row (or one BullMQ rejection)
 * must not abort boot and take the whole API down with it.
 */
export async function rescheduleAllTasks(
  prisma: PrismaClient,
  tz: string,
  logger: FastifyBaseLogger,
): Promise<number> {
  if (!_queue) return 0;

  const tasks = await prisma.scheduledTask.findMany({
    where: { enabled: true },
    select: { id: true, schedule: true },
  });

  let armed = 0;
  for (const task of tasks) {
    try {
      const next = await scheduleTaskJob(_queue, task.id, task.schedule, tz);
      await prisma.scheduledTask.update({
        where: { id: task.id },
        data: { nextRunAt: next },
      });
      armed += 1;
    } catch (err) {
      logger.error(
        { err, taskId: task.id, schedule: task.schedule },
        "Failed to arm scheduled task at boot — skipping it",
      );
      await prisma.scheduledTask
        .update({ where: { id: task.id }, data: { nextRunAt: null } })
        .catch((updateErr) => {
          logger.error({ err: updateErr, taskId: task.id }, "Failed to clear nextRunAt for unarmable task");
        });
    }
  }

  return armed;
}
