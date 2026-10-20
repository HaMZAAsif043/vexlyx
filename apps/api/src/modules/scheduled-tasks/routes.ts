import type { FastifyInstance, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import { ScheduledTaskService, ScheduledTaskError } from "./service.js";
import { AuditLogService } from "../audit-log/service.js";
import {
  CreateScheduledTaskSchema,
  UpdateScheduledTaskSchema,
  ScheduledTaskIdParamSchema,
  ScheduledTaskProjectParamSchema,
  RunNowBodySchema,
  ScheduledTaskListQuerySchema,
} from "./schema.js";
import { createQueue, createWorker } from "../../config/queue.js";
import { SystemService } from "../system/service.js";
import {
  SCHEDULED_TASK_QUEUE_NAME,
  registerScheduledTaskQueue,
  applyTaskSchedule,
  refreshNextRunAt,
  rescheduleAllTasks,
  unscheduleTaskJob,
} from "./scheduler.js";

type ScheduledTaskWithProject = Prisma.ScheduledTaskGetPayload<{
  include: { project: true };
}>;

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleScheduledTaskError(err: unknown, reply: FastifyReply): void {
  if (err instanceof ScheduledTaskError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  throw err;
}

// cron-parser (what BullMQ arms with) rejects patterns with these fixed error
// prefixes; anything else while arming is an infrastructure failure (Redis …).
const CRON_PATTERN_ERROR =
  /(constraint error|invalid characters|invalid range|validation error|missing fields|invalid cron)/i;

/**
 * Classifies an arming failure. Callers use it to keep create/update atomic:
 * the row is rolled back/reverted so the saved state always matches what is
 * actually armed in BullMQ.
 */
function scheduleArmFailure(err: unknown): ScheduledTaskError {
  const detail = err instanceof Error ? err.message : String(err);
  if (CRON_PATTERN_ERROR.test(detail)) {
    return new ScheduledTaskError(`Invalid cron schedule: ${detail}`, "INVALID_SCHEDULE", 400);
  }
  return new ScheduledTaskError(`Could not arm schedule: ${detail}`, "SCHEDULE_ARM_FAILED", 500);
}

export async function scheduledTaskRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const service = new ScheduledTaskService(app.prisma, app.log, auditLog, app.redis);
  const systemService = new SystemService(app.prisma);

  // ---------------------------------------------------------------------------
  // BullMQ — one queue for both scheduled triggers and worker-side execution
  // ---------------------------------------------------------------------------

  // Bounded job retention: every firing leaves a job behind, and the run
  // history already lives in PostgreSQL — Redis must not grow without limit.
  const taskQueue = createQueue(SCHEDULED_TASK_QUEUE_NAME, {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });
  registerScheduledTaskQueue(taskQueue);

  const taskWorker = createWorker<{ taskId: string; trigger: "SCHEDULED" | "MANUAL" }>(
    SCHEDULED_TASK_QUEUE_NAME,
    async (job) => {
      const { taskId, trigger } = job.data;
      const task = await app.prisma.scheduledTask.findUnique({
        where: { id: taskId },
        include: { project: true },
      });
      if (!task) return;

      // A deleted project keeps its DB row but loses its workspace; its tasks
      // must stop firing instead of recording failures and emailing the owner.
      if (task.project.deletedAt !== null) {
        app.log.warn({ taskId }, "Scheduled task belongs to a deleted project — disabling it");
        await app.prisma.scheduledTask.updateMany({
          where: { id: taskId, enabled: true },
          data: { enabled: false, nextRunAt: null },
        });
        try {
          await unscheduleTaskJob(taskQueue, taskId, app.log);
        } catch {
          // Already logged by unscheduleTaskJob; the task is disabled either way.
        }
        return;
      }

      if (!task.enabled) return;
      try {
        await service.executeTask(task as ScheduledTaskWithProject, trigger);
      } catch (err) {
        // executeTask already recorded the FAILED run; a scheduled trigger
        // must not retry the job (that would double-count the streak).
        app.log.error({ err, taskId }, "Scheduled task execution failed");
      } finally {
        // BullMQ has already queued the next firing by now — persist it so the
        // dashboard never keeps showing the run that just happened.
        if (trigger === "SCHEDULED") {
          await refreshNextRunAt(app.prisma, taskQueue, taskId, app.log);
        }
      }
    },
    app,
    { concurrency: 5 },
  );

  app.registerQueue(taskQueue, taskWorker);

  // Re-arm every enabled task on boot and refresh its persisted nextRunAt.
  // Missed runs while the API was down are not back-filled (documented).
  const { timezone } = await systemService.getSettings();
  const armedCount = await rescheduleAllTasks(app.prisma, timezone, app.log);
  app.log.info({ count: armedCount, timezone }, "Scheduled tasks armed");

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks — list tasks
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ScheduledTaskProjectParamSchema.parse(request.params);
      const tasks = await service.list(id, request.userId!, request.userRole!);
      return { tasks };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/projects/:id/scheduled-tasks — create task
  // ---------------------------------------------------------------------------

  app.post("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ScheduledTaskProjectParamSchema.parse(request.params);
      const body = CreateScheduledTaskSchema.parse(request.body);
      const task = await service.create(id, request.userId!, request.userRole!, body);

      if (task.enabled) {
        const { timezone: tz } = await systemService.getSettings();
        let nextRunAt: Date | null = null;
        try {
          nextRunAt = await applyTaskSchedule(taskQueue, app.prisma, task, tz, app.log);
        } catch (err) {
          // BullMQ refused the schedule — never leave a saved task behind that
          // can never fire (it would be re-armed on every boot).
          app.log.error(
            { err, taskId: task.id, schedule: task.schedule },
            "Failed to arm new scheduled task — rolling back",
          );
          // The arm may already have reached BullMQ (upsert succeeded and a
          // later step failed) — disarm so Redis keeps no job for a task row
          // that is about to be deleted.
          await unscheduleTaskJob(taskQueue, task.id, app.log).catch((unscheduleErr) =>
            app.log.error(
              { err: unscheduleErr, taskId: task.id },
              "Failed to disarm schedule while rolling back unschedulable task",
            ),
          );
          await app.prisma.scheduledTask
            .delete({ where: { id: task.id } })
            .catch((delErr) => app.log.error({ err: delErr, taskId: task.id }, "Failed to roll back unschedulable task"));
          throw scheduleArmFailure(err);
        }
        reply.status(201);
        return { ...task, nextRunAt };
      }

      reply.status(201);
      return task;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks/:taskId — task detail
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      // list() performs the same ownership/role access check for the project
      await service.list(id, request.userId!, request.userRole!);
      return task;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /api/projects/:id/scheduled-tasks/:taskId — update task
  // ---------------------------------------------------------------------------

  app.put("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const body = UpdateScheduledTaskSchema.parse(request.body);

      const currentTask = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!currentTask || currentTask.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }

      const updated = await service.update(taskId, request.userId!, request.userRole!, body);

      // Re-arm the scheduler whenever the schedule or enabled state changed
      if (body.schedule !== undefined || body.enabled !== undefined) {
        const { timezone: tz } = await systemService.getSettings();
        try {
          const nextRunAt = await applyTaskSchedule(taskQueue, app.prisma, updated, tz, app.log);
          return { ...updated, nextRunAt };
        } catch (err) {
          // Roll the schedule change back so the saved row always matches what
          // BullMQ is actually armed with.
          app.log.error(
            { err, taskId, schedule: updated.schedule },
            "Failed to arm updated schedule — reverting change",
          );
          await app.prisma.scheduledTask
            .update({
              where: { id: taskId },
              data: {
                schedule: currentTask.schedule,
                enabled: currentTask.enabled,
                nextRunAt: currentTask.nextRunAt,
              },
            })
            .catch((revertErr) => app.log.error({ err: revertErr, taskId }, "Failed to revert schedule change"));
          // The failed apply may already have moved BullMQ (the upsert
          // succeeded and only the nextRunAt write failed, or an unschedule
          // dropped the scheduler). Re-arm the reverted state so Redis and the
          // saved row never disagree — otherwise a rejected disable can leave
          // an enabled task with no scheduler, or a task firing on a schedule
          // the row no longer shows.
          try {
            await applyTaskSchedule(taskQueue, app.prisma, currentTask, tz, app.log);
          } catch (restoreErr) {
            app.log.error(
              { err: restoreErr, taskId, schedule: currentTask.schedule },
              "Failed to restore previous schedule in BullMQ",
            );
          }
          throw scheduleArmFailure(err);
        }
      }

      return updated;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/projects/:id/scheduled-tasks/:taskId — delete task
  // ---------------------------------------------------------------------------

  app.delete("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      // Authorize first: a 403/404 must never leave the schedule disarmed.
      const task = await service.getForManage(taskId, request.userId!, request.userRole!);
      if (task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      // Disarm first: if BullMQ refuses, the request fails while the task and
      // its scheduler are still in sync (never "deleted but still firing").
      await unscheduleTaskJob(taskQueue, taskId, app.log);
      try {
        await service.delete(taskId, request.userId!, request.userRole!);
      } catch (err) {
        // The scheduler is already disarmed — if the row survives, re-arm it
        // so a rejected delete never leaves an enabled task that silently
        // stops running.
        try {
          const { timezone: tz } = await systemService.getSettings();
          await applyTaskSchedule(taskQueue, app.prisma, task, tz, app.log);
        } catch (restoreErr) {
          app.log.error(
            { err: restoreErr, taskId, schedule: task.schedule },
            "Failed to restore schedule after failed delete",
          );
        }
        throw err;
      }
      reply.status(204);
      return null;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/projects/:id/scheduled-tasks/:taskId/run — run now
  // ---------------------------------------------------------------------------

  app.post("/:id/scheduled-tasks/:taskId/run", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      RunNowBodySchema.parse(request.body ?? {});
      const run = await service.runNow(taskId, request.userId!, request.userRole!);
      reply.status(200);
      return { message: "Task execution finished", run };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks/:taskId/runs — run history
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks/:taskId/runs", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      const { limit } = ScheduledTaskListQuerySchema.parse(request.query);
      const runs = await service.getRuns(taskId, request.userId!, request.userRole!, limit);
      return { runs };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });
}
