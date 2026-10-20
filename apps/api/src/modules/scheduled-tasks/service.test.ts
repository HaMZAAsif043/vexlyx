import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FastifyBaseLogger } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../system-email/notifier.js", () => ({ notifyUser: vi.fn() }));

import { spawn } from "node:child_process";
import { notifyUser } from "../system-email/notifier.js";

const { ScheduledTaskService } = await import("./service.js");

const spawnMock = vi.mocked(spawn);
const notifyUserMock = vi.mocked(notifyUser);

// ---------------------------------------------------------------------------
// Fake docker_manager.py child process — writes the JSON result on stdin.end
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: Mock; end: Mock };
  terminate: Mock;
  kill: Mock;
}

function fakeChild(payload: Record<string, unknown>, exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.terminate = vi.fn();
  child.kill = vi.fn();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
        child.emit("close", exitCode);
      });
    }),
  };
  return child;
}

function execResult(fields: Partial<{ exitCode: number; output: string; timedOut: boolean }> = {}) {
  return fakeChild({ exitCode: 0, output: "", timedOut: false, containerId: "c1", ...fields });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
const auditLog = { log: vi.fn(async () => undefined) } as never;

function createPrisma() {
  return {
    project: { findUnique: vi.fn() },
    scheduledTask: {
      findUnique: vi.fn(),
      findMany: vi.fn(async (): Promise<{ id: string }[]> => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(async () => 0),
    },
    scheduledTaskRun: {
      findMany: vi.fn(async (): Promise<{ id: string; status?: string }[]> => []),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: "owner-1", email: "owner@example.com", role: "USER", resellerId: null })),
    },
  };
}

function createRedis(setResult: "OK" | null = "OK") {
  return { set: vi.fn(async () => setResult), eval: vi.fn(async () => 1) };
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    projectId: "p1",
    userId: "owner-1",
    name: "Nightly cleanup",
    command: "echo hi",
    schedule: "0 0 * * *",
    timeoutSeconds: 300,
    enabled: true,
    notifyOnFailure: true,
    consecutiveFailures: 0,
    lastRunAt: null,
    nextRunAt: null,
    project: {
      id: "p1",
      name: "my-project",
      type: "NODEJS",
      userId: "owner-1",
      containerId: "c1",
      containerStatus: "running",
    },
    ...overrides,
  };
}

const RUNNING_ROW = { id: "run-1", taskId: "task-1", trigger: "MANUAL", status: "RUNNING" };

function finishedRow(status: string, exitCode: number | null, output: string | null) {
  return { id: "run-1", taskId: "task-1", status, exitCode, output, finishedAt: new Date() };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScheduledTaskService.executeTask", () => {
  it("records a SUCCESS run, updates the row in place and releases the lock", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("SUCCESS", 0, "hello"));
    spawnMock.mockReturnValue(execResult({ exitCode: 0, output: "hello" }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const run = await service.executeTask(baseTask() as never, "MANUAL");

    expect(run.status).toBe("SUCCESS");
    expect(prisma.scheduledTaskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "SUCCESS", exitCode: 0, output: "hello" }),
      }),
    );
    expect(prisma.scheduledTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 0 }) }),
    );
    expect(redis.eval).toHaveBeenCalled();
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("records SKIPPED without running anything when the lock is held (no overlap)", async () => {
    const prisma = createPrisma();
    const redis = createRedis(null);
    prisma.scheduledTaskRun.create.mockResolvedValue({ ...RUNNING_ROW, status: "SKIPPED" });

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const run = await service.executeTask(baseTask() as never, "SCHEDULED");

    expect(run.status).toBe("SKIPPED");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(prisma.scheduledTaskRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED" }) }),
    );
  });

  it("records SKIPPED when the project is not running", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue({ ...RUNNING_ROW, status: "SKIPPED" });

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const task = baseTask({ project: { ...baseTask().project, containerStatus: "exited" } });
    const run = await service.executeTask(task as never, "SCHEDULED");

    expect(run.status).toBe("SKIPPED");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("emails the task owner once when the failure streak reaches three", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("FAILED", 1, "boom"));
    spawnMock.mockReturnValue(execResult({ exitCode: 1, output: "boom" }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await service.executeTask(baseTask({ consecutiveFailures: 2 }) as never, "SCHEDULED");

    expect(prisma.scheduledTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 3 }) }),
    );
    expect(notifyUserMock).toHaveBeenCalledWith(
      "scheduled_task_failed",
      "owner@example.com",
      expect.objectContaining({ taskName: "Nightly cleanup", projectName: "my-project" }),
    );
  });

  it("does not email below the threshold or when notifyOnFailure is off", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("FAILED", 1, "boom"));
    spawnMock.mockReturnValue(execResult({ exitCode: 1 }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await service.executeTask(baseTask({ consecutiveFailures: 1 }) as never, "SCHEDULED");
    expect(notifyUserMock).not.toHaveBeenCalled();

    await service.executeTask(baseTask({ consecutiveFailures: 2, notifyOnFailure: false }) as never, "SCHEDULED");
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("resets the streak on SUCCESS", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("SUCCESS", 0, ""));
    spawnMock.mockReturnValue(execResult({ exitCode: 0 }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await service.executeTask(baseTask({ consecutiveFailures: 4 }) as never, "SCHEDULED");

    expect(prisma.scheduledTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 0 }) }),
    );
  });

  it("counts a timeout as a failure", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("TIMEOUT", null, "partial"));
    spawnMock.mockReturnValue(execResult({ exitCode: 124, output: "partial", timedOut: true }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const run = await service.executeTask(baseTask() as never, "SCHEDULED");

    expect(run.status).toBe("TIMEOUT");
    expect(prisma.scheduledTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consecutiveFailures: 1 }) }),
    );
  });

  it("trims run history to the latest 50 runs", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("SUCCESS", 0, ""));
    prisma.scheduledTaskRun.findMany.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);
    spawnMock.mockReturnValue(execResult() as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await service.executeTask(baseTask() as never, "MANUAL");

    expect(prisma.scheduledTaskRun.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1", "old-2"] } },
    });
  });

  it("never trims a run that is still executing", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("SUCCESS", 0, ""));
    prisma.scheduledTaskRun.findMany.mockResolvedValue([
      { id: "active-1", status: "RUNNING" },
      { id: "old-1", status: "FAILED" },
    ]);
    spawnMock.mockReturnValue(execResult() as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await service.executeTask(baseTask() as never, "MANUAL");

    expect(prisma.scheduledTaskRun.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1"] } },
    });
  });

  it("does not exec into a deleted project's workspace", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue({ ...RUNNING_ROW, status: "SKIPPED" });

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const task = baseTask({ project: { ...baseTask().project, deletedAt: new Date() } });
    const run = await service.executeTask(task as never, "SCHEDULED");

    expect(run.status).toBe("SKIPPED");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(prisma.scheduledTaskRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ output: "Project deleted" }) }),
    );
  });

  it("never rewrites a successful run when saving its result fails", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    // The command exited 0, but persisting the outcome hits a database error.
    prisma.scheduledTaskRun.update.mockRejectedValue(new Error("Connection is closed."));
    spawnMock.mockReturnValue(execResult({ exitCode: 0, output: "hello" }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);

    await expect(service.executeTask(baseTask() as never, "MANUAL")).rejects.toThrow("Connection is closed.");

    // The single write attempted was the command's real result — the database
    // error must never be recorded as a command failure…
    expect(prisma.scheduledTaskRun.update).toHaveBeenCalledTimes(1);
    expect(prisma.scheduledTaskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS" }) }),
    );
    // …and the failure streak stays untouched (no false failure email).
    expect(prisma.scheduledTask.update).not.toHaveBeenCalled();
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("keeps the run's real result when only the streak update fails", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.scheduledTaskRun.create.mockResolvedValue(RUNNING_ROW);
    prisma.scheduledTaskRun.update.mockResolvedValue(finishedRow("SUCCESS", 0, "hello"));
    prisma.scheduledTask.update.mockRejectedValue(new Error("Connection is closed."));
    spawnMock.mockReturnValue(execResult({ exitCode: 0, output: "hello" }) as never);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const run = await service.executeTask(baseTask() as never, "MANUAL");

    expect(run.status).toBe("SUCCESS");
    expect(prisma.scheduledTaskRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS" }) }),
    );
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
      "Failed to update scheduled task streak",
    );
    expect(notifyUserMock).not.toHaveBeenCalled();
  });
});

describe("ScheduledTaskService.create — access & quota", () => {
  it("lets a reseller create a task on a sub-account's project", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.project.findUnique.mockResolvedValue({ id: "p1", userId: "owner-1" });
    prisma.user.findUnique.mockResolvedValue({ id: "owner-1", role: "USER", resellerId: "reseller-1", maxScheduledTasks: null });
    prisma.scheduledTask.create.mockResolvedValue({ id: "task-1" });

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    const task = await service.create("p1", "reseller-1", "RESELLER", {
      name: "t",
      command: "echo",
      schedule: "* * * * *",
      timeoutSeconds: 300,
      enabled: true,
      notifyOnFailure: true,
    });

    expect(task.id).toBe("task-1");
    expect(prisma.scheduledTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "owner-1" }) }),
    );
  });

  it("rejects another reseller's sub-account with 403", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.project.findUnique.mockResolvedValue({ id: "p1", userId: "owner-1" });
    prisma.user.findUnique.mockResolvedValue({ id: "owner-1", role: "USER", resellerId: "other-reseller" });

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await expect(
      service.create("p1", "reseller-1", "RESELLER", {
        name: "t",
        command: "echo",
        schedule: "* * * * *",
        timeoutSeconds: 300,
        enabled: true,
        notifyOnFailure: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("enforces maxScheduledTasks with QUOTA_EXCEEDED", async () => {
    const prisma = createPrisma();
    const redis = createRedis();
    prisma.project.findUnique.mockResolvedValue({ id: "p1", userId: "owner-1" });
    prisma.user.findUnique.mockResolvedValue({ id: "owner-1", role: "USER", resellerId: null, maxScheduledTasks: 0 });
    prisma.scheduledTask.count.mockResolvedValue(0);

    const service = new ScheduledTaskService(prisma as never, logger, auditLog, redis);
    await expect(
      service.create("p1", "owner-1", "USER", {
        name: "t",
        command: "echo",
        schedule: "* * * * *",
        timeoutSeconds: 300,
        enabled: true,
        notifyOnFailure: true,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", statusCode: 403 });
  });
});
