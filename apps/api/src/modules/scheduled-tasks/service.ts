import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient, ScheduledTaskRunStatus } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../config/env.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "../../utils/processWatchdog.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ScheduledTaskError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}

// ---------------------------------------------------------------------------
// Limits (mirrors the feature spec's "Guards" section)
// ---------------------------------------------------------------------------

const OUTPUT_CAP_BYTES = 65536;
const RUN_HISTORY_LIMIT = 50;
const FAILURE_EMAIL_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Minimal Redis surface needed for the per-task overlap lock — kept structural
// so unit tests can pass a stub without importing ioredis.
// ---------------------------------------------------------------------------

export interface RedisLike {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttl: number,
    nx: "NX",
  ): Promise<"OK" | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Compare-and-delete so only the lock holder releases its own lock.
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

// ---------------------------------------------------------------------------
// Helper — locate docker_manager.py (mirrors backup service)
// ---------------------------------------------------------------------------

function getDockerManagerPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/docker_manager.py"),
    resolve(currentDir, "../../../../system/python/docker_manager.py"),
    resolve(process.cwd(), "../../system/python/docker_manager.py"),
    resolve(process.cwd(), "system/python/docker_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/docker_manager.py");
}

// ---------------------------------------------------------------------------
// Helper — run a docker_manager.py command
// ---------------------------------------------------------------------------

function runDockerManager<T>(
  payload: Record<string, unknown>,
  logger: FastifyBaseLogger,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = getDockerManagerPath();
    const body = JSON.stringify(payload);

    const pythonBin = getPythonBin();

    const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    // Backstop only: docker_manager.py enforces the task's own timeout (max
    // 3600s) and kills the container-side process tree — this catches a
    // wedged script that never answers at all.
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.exec, (ms) =>
      reject(
        new ScheduledTaskError(
          `Scheduled task script timed out after ${Math.round(ms / 1000)}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";
    let result: unknown = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed && typeof parsed === "object" && "log" in parsed) {
          // Progress logs carry no result payload; the final JSON line wins.
        } else {
          result = parsed;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ err }, "docker_manager.py spawn error");
      reject(new ScheduledTaskError(`Failed to start docker_manager.py: ${err.message}`, "SPAWN_ERROR", 500));
    });

    child.on("close", (code) => {
      const trailing = stdout.trim();
      if (trailing) {
        try {
          const parsed = JSON.parse(trailing);
          if (parsed && typeof parsed === "object" && !("log" in parsed)) {
            result = parsed;
          }
        } catch {
          // ignore trailing partial output
        }
      }

      if (stderr) {
        logger.debug({ stderr }, "docker_manager.py stderr output");
      }

      const stderrDetail = stderr.trim().slice(0, 2000);

      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof (result as Record<string, unknown>).error === "string"
      ) {
        const err = result as { error: string; code?: string };
        reject(new ScheduledTaskError(err.error, err.code ?? "DOCKER_MANAGER_ERROR", 500));
        return;
      }

      if (result === null) {
        const message = stderrDetail
          ? `Docker manager script exited with code ${code}: ${stderrDetail}`
          : `Docker manager script exited with code ${code} and no output`;
        reject(new ScheduledTaskError(message, "EMPTY_OUTPUT", 500));
        return;
      }

      if (code !== 0) {
        const message = stderrDetail
          ? `Docker manager script exited with code ${code}: ${stderrDetail}`
          : `Docker manager script exited with code ${code}`;
        reject(new ScheduledTaskError(message, "SCRIPT_ERROR", 500));
        return;
      }

      resolvePromise(result as T);
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledTaskWithProject {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  command: string;
  schedule: string;
  timeoutSeconds: number;
  enabled: boolean;
  notifyOnFailure: boolean;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  project: {
    id: string;
    name: string;
    type: string;
    userId: string;
    containerId: string | null;
    containerStatus: string | null;
    deletedAt: Date | null;
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScheduledTaskService {
  constructor(
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
    private auditLog: AuditLogService,
    private redis: RedisLike,
  ) {}

  async list(projectId: string, userId: string, role: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt) throw new ScheduledTaskError("Project not found", "PROJECT_NOT_FOUND", 404);
    await this.assertAccess(userId, role, project.userId);

    return this.prisma.scheduledTask.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(
    projectId: string,
    userId: string,
    role: string,
    data: { name: string; command: string; schedule: string; timeoutSeconds: number; enabled: boolean; notifyOnFailure: boolean },
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt) throw new ScheduledTaskError("Project not found", "PROJECT_NOT_FOUND", 404);
    await this.assertAccess(userId, role, project.userId);
    await assertUnderQuota(
      this.prisma,
      project.userId,
      "scheduledTask",
      (message, code, statusCode) => new ScheduledTaskError(message, code, statusCode),
    );

    const task = await this.prisma.scheduledTask.create({
      data: { projectId, userId: project.userId, ...data },
    });

    await this.auditLog.log(userId, "scheduled_task.created", { type: "ScheduledTask", id: task.id }, {
      after: { name: task.name, schedule: task.schedule },
    });

    void notifyQuotaThreshold(this.prisma, project.userId, "scheduledTask");

    return task;
  }

  async update(
    taskId: string,
    userId: string,
    role: string,
    data: Partial<{ name: string; command: string; schedule: string; timeoutSeconds: number; enabled: boolean; notifyOnFailure: boolean }>,
  ) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) throw new ScheduledTaskError("Task not found", "TASK_NOT_FOUND", 404);
    await this.assertAccess(userId, role, task.project.userId);

    const updated = await this.prisma.scheduledTask.update({
      where: { id: taskId },
      data,
    });

    await this.auditLog.log(userId, "scheduled_task.updated", { type: "ScheduledTask", id: taskId }, {
      after: data,
    });

    return updated;
  }

  /**
   * Fetches a task together with its project and verifies the caller may
   * manage it. Used before side effects (e.g. disarming a scheduler) so that a
   * 403/404 can never leave the task in a half-modified state.
   */
  async getForManage(taskId: string, userId: string, role: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) throw new ScheduledTaskError("Task not found", "TASK_NOT_FOUND", 404);
    await this.assertAccess(userId, role, task.project.userId);
    return task;
  }

  async delete(taskId: string, userId: string, role: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) throw new ScheduledTaskError("Task not found", "TASK_NOT_FOUND", 404);
    await this.assertAccess(userId, role, task.project.userId);

    await this.prisma.scheduledTask.delete({ where: { id: taskId } });

    await this.auditLog.log(userId, "scheduled_task.deleted", { type: "ScheduledTask", id: taskId }, {
      before: { name: task.name },
    });
  }

  async runNow(taskId: string, userId: string, role: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) throw new ScheduledTaskError("Task not found", "TASK_NOT_FOUND", 404);
    await this.assertAccess(userId, role, task.project.userId);
    if (task.project.deletedAt) throw new ScheduledTaskError("Project not found", "PROJECT_NOT_FOUND", 404);

    await this.auditLog.log(userId, "scheduled_task.run_now", { type: "ScheduledTask", id: taskId }, {
      after: { name: task.name },
    });

    return this.executeTask(task as ScheduledTaskWithProject, "MANUAL");
  }

  async getRuns(taskId: string, userId: string, role: string, limit = 50) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) throw new ScheduledTaskError("Task not found", "TASK_NOT_FOUND", 404);
    await this.assertAccess(userId, role, task.project.userId);

    return this.prisma.scheduledTaskRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  }

  /**
   * Executes a task inside the project's container (used by both the BullMQ
   * scheduler and "run now"). A per-task Redis lock prevents overlapping runs
   * (an overlapping run is recorded as SKIPPED, not failed); the run row is
   * created as RUNNING and updated in place with the final status so history
   * never accumulates orphaned RUNNING entries.
   */
  async executeTask(task: ScheduledTaskWithProject, trigger: "SCHEDULED" | "MANUAL") {
    const lockKey = `scheduled-task:lock:${task.id}`;
    const lockValue = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const acquired = await this.redis.set(
      lockKey,
      lockValue,
      "EX",
      task.timeoutSeconds + 30,
      "NX",
    );

    if (acquired !== "OK") {
      return this.recordRun(task.id, trigger, "SKIPPED", null, "Previous run still in progress");
    }

    try {
      const project = task.project;
      // Defence in depth: the worker disables a deleted project's tasks, but a
      // manual run can still race a deletion — never exec into a removed
      // workspace.
      if (project.deletedAt) {
        return await this.recordRun(task.id, trigger, "SKIPPED", null, "Project deleted");
      }
      if (!project.containerId || project.containerStatus !== "running") {
        return await this.recordRun(task.id, trigger, "SKIPPED", null, "Project not running");
      }

      const run = await this.prisma.scheduledTaskRun.create({
        data: { taskId: task.id, trigger, status: "RUNNING" },
      });

      let result: { exitCode: number; output: string; timedOut: boolean };
      try {
        result = await runDockerManager<{ exitCode: number; output: string; timedOut: boolean }>({
          command: "exec",
          projectDir: resolve(env.PROJECTS_DIR, project.id),
          projectType: project.type,
          shellCommand: task.command,
          timeout: task.timeoutSeconds,
          outputLimit: OUTPUT_CAP_BYTES,
        }, this.logger);
      } catch (err) {
        // Spawn/infrastructure failure of the command itself. The caller must
        // see the original error, not a persistence failure that shadows it.
        const message = err instanceof Error ? err.message : "Execution failed";
        try {
          await this.persistOutcome(task, run.id, "FAILED", null, message);
        } catch (persistErr) {
          this.logger.error(
            { err: persistErr, runId: run.id, taskId: task.id },
            "Failed to persist scheduled task failure",
          );
        }
        // Surface spawn/infrastructure errors to the caller; scheduled runs
        // are logged by the worker, which deliberately does not rethrow.
        throw err;
      }

      // The command finished — its outcome is whatever the container reported.
      // Errors while saving that outcome (or updating the streak) are handled
      // inside persistOutcome and never rewrite a successful run as FAILED.
      const status = result.timedOut ? "TIMEOUT" : (result.exitCode === 0 ? "SUCCESS" : "FAILED");
      return await this.persistOutcome(task, run.id, status, result.exitCode, result.output);
    } finally {
      try {
        await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockValue);
      } catch (err) {
        // Never swallow: an unreleased lock only expires with its TTL, which
        // silently delays the next run.
        this.logger.error({ err, taskId: task.id }, "Failed to release scheduled task overlap lock");
      }
    }
  }

  /**
   * Records a finished run and updates the task's failure streak. These are
   * database writes that happen *after* the command produced its result: a
   * failure here must never rewrite that result (a successful command would
   * otherwise show up as FAILED and send a false failure email). A failed
   * result write is rethrown (the caller cannot return a run it could not
   * save); a failed streak update is logged and swallowed — the run row
   * already carries the truth.
   */
  private async persistOutcome(
    task: ScheduledTaskWithProject,
    runId: string,
    status: ScheduledTaskRunStatus,
    exitCode: number | null,
    output: string | null,
  ) {
    let finished: Awaited<ReturnType<typeof this.finishRun>>;
    try {
      finished = await this.finishRun(runId, status, exitCode, output);
    } catch (err) {
      this.logger.error(
        { err, runId, taskId: task.id, status },
        "Failed to persist scheduled task run result",
      );
      throw err;
    }
    try {
      await this.updateStreak(task, status, finished);
    } catch (err) {
      this.logger.error({ err, taskId: task.id, status }, "Failed to update scheduled task streak");
    }
    return finished;
  }

  private async finishRun(
    runId: string,
    status: ScheduledTaskRunStatus,
    exitCode: number | null,
    output: string | null,
  ) {
    const finished = await this.prisma.scheduledTaskRun.update({
      where: { id: runId },
      data: {
        status,
        exitCode,
        output: output?.slice(0, OUTPUT_CAP_BYTES) ?? null,
        finishedAt: new Date(),
      },
    });
    await this.trimRunHistory(finished.taskId);
    return finished;
  }

  private async recordRun(
    taskId: string,
    trigger: "SCHEDULED" | "MANUAL",
    status: ScheduledTaskRunStatus,
    exitCode: number | null,
    output: string | null,
  ) {
    const run = await this.prisma.scheduledTaskRun.create({
      data: {
        taskId,
        trigger,
        status,
        exitCode,
        output: output?.slice(0, OUTPUT_CAP_BYTES) ?? null,
        finishedAt: new Date(),
      },
    });
    await this.trimRunHistory(taskId);
    return run;
  }

  /** Keeps only the latest RUN_HISTORY_LIMIT runs per task (spec: 50). */
  private async trimRunHistory(taskId: string) {
    const candidates = await this.prisma.scheduledTaskRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "desc" },
      skip: RUN_HISTORY_LIMIT,
      select: { id: true, status: true },
    });
    // A long-running task can be pushed past the limit by newer SKIPPED rows;
    // never delete the run that is still executing (its finish would 404).
    const stale = candidates.filter((run) => run.status !== "RUNNING");
    if (stale.length > 0) {
      await this.prisma.scheduledTaskRun.deleteMany({
        where: { id: { in: stale.map((r) => r.id) } },
      });
    }
  }

  private async updateStreak(
    task: ScheduledTaskWithProject,
    status: ScheduledTaskRunStatus,
    run: { id: string; output: string | null },
  ) {
    if (status === "SUCCESS") {
      await this.prisma.scheduledTask.update({
        where: { id: task.id },
        data: { consecutiveFailures: 0, lastRunAt: new Date() },
      });
      return;
    }

    if (status !== "FAILED" && status !== "TIMEOUT") return;

    const newFailures = task.consecutiveFailures + 1;
    await this.prisma.scheduledTask.update({
      where: { id: task.id },
      data: { consecutiveFailures: newFailures, lastRunAt: new Date() },
    });

    // One email per failure streak, to the task's owner (cPanel-style).
    if (task.notifyOnFailure && newFailures === FAILURE_EMAIL_THRESHOLD) {
      const owner = await this.prisma.user.findUnique({
        where: { id: task.userId },
        select: { email: true },
      });
      if (owner) {
        notifyUser("scheduled_task_failed", owner.email, {
          taskName: task.name,
          projectName: task.project.name,
          output: run.output?.slice(0, 500) ?? "",
          runId: run.id,
        });
      }
    }
  }

  /**
   * Owners manage their own projects' tasks; admins manage everything;
   * resellers manage the tasks of their sub-accounts (checked via the
   * owner's `resellerId`, not the caller's own — a RESELLER's resellerId
   * is always null).
   */
  private async assertAccess(userId: string, role: string, ownerId: string) {
    if (role === "ADMIN") return;
    if (userId === ownerId) return;
    if (role === "RESELLER") {
      const owner = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { resellerId: true },
      });
      if (owner?.resellerId === userId) return;
    }
    throw new ScheduledTaskError("Forbidden", "FORBIDDEN", 403);
  }
}
