import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { encryptMock, decryptMock } = vi.hoisted(() => ({
  encryptMock: vi.fn(),
  decryptMock: vi.fn(),
}));
vi.mock("../../utils/encryption.js", () => ({
  encrypt: encryptMock,
  decrypt: decryptMock,
}));

const { RedisInstanceService, RedisInstanceError } = await import("./service.js");

const USER_ID = "u1";
const INSTANCE_ID = "ri1";
const CONTAINER = "vexlyx-redis-shop-a1b2c3d4e5f6";

/** Fake redis_manager.py process: writes `stdout` then exits with `code`. */
function scriptResult(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: () => void; end: () => void };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => undefined,
    end: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
    },
  };
  return child;
}

function fixture(recordOverrides: Record<string, unknown> = {}, findUniqueResult?: unknown) {
  const record = {
    id: INSTANCE_ID,
    userId: USER_ID,
    name: "shop_cache",
    containerName: CONTAINER,
    imageTag: "valkey/valkey:8.0",
    memoryLimitMb: 64,
    evictionPolicy: "noeviction",
    persistence: "RDB",
    // 32 x "a": valid per redis_manager's [A-Za-z0-9]{16,128} rule.
    passwordEncrypted: "stored-ciphertext",
    status: "RUNNING",
    projectId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    project: null,
    ...recordOverrides,
  };
  const prisma = {
    redisInstance: {
      // create()'s name-collision check hits findUnique first; tests that
      // don't exercise it pass `null` explicitly to mean "no existing instance".
      findUnique: vi.fn().mockResolvedValue(findUniqueResult === undefined ? record : findUniqueResult),
      findMany: vi.fn().mockResolvedValue([record]),
      create: vi.fn().mockResolvedValue(record),
      update: vi.fn().mockResolvedValue(record),
      delete: vi.fn().mockResolvedValue(record),
    },
    project: {
      findFirst: vi.fn().mockResolvedValue({ id: "p1" }),
    },
    // assertUnderQuota/notifyQuotaThreshold look the user up; null means
    // "no quota configured, no reseller" — the checks pass trivially.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new RedisInstanceService(
    prisma as unknown as PrismaClient,
    auditLog as never,
  );
  return { prisma, auditLog, service, record };
}

beforeEach(() => {
  spawnMock.mockReset();
  encryptMock.mockReset().mockReturnValue("encrypted-ciphertext");
  decryptMock.mockReset().mockReturnValue("oldPassword0123456789abcdefghij");
});

describe("RedisInstanceService.delete (F5.30)", () => {
  it("removes container + volume, deletes the record and audits it once the engine confirms", async () => {
    spawnMock.mockReturnValue(scriptResult(JSON.stringify({ success: true, containerRemoved: true }), 0));
    const { prisma, auditLog, service } = fixture();

    await expect(service.delete(INSTANCE_ID, USER_ID)).resolves.toEqual({ success: true, id: INSTANCE_ID });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.stringContaining("redis_manager.py")]),
      expect.anything(),
    );
    expect(prisma.redisInstance.delete).toHaveBeenCalledWith({ where: { id: INSTANCE_ID } });
    expect(auditLog.log).toHaveBeenCalledWith(
      USER_ID,
      "redis_instance.deleted",
      { type: "RedisInstance", id: INSTANCE_ID },
      expect.anything(),
    );
  });

  it("keeps the record and writes no audit event when teardown fails", async () => {
    spawnMock.mockReturnValue(
      scriptResult(
        JSON.stringify({ error: "Failed to remove container 'x'. It may still be running; retry the delete.", code: "TEARDOWN_FAILED" }),
        1,
      ),
    );
    const { prisma, auditLog, service } = fixture();

    const err = await service.delete(INSTANCE_ID, USER_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedisInstanceError);
    expect(err).toMatchObject({ code: "REDIS_TEARDOWN_FAILED", statusCode: 502 });
    expect((err as Error).message).toContain("shop_cache");
    expect(prisma.redisInstance.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("404s for another user's instance", async () => {
    spawnMock.mockReturnValue(scriptResult(JSON.stringify({ success: true }), 0));
    const { service } = fixture({ userId: "someone-else" });

    await expect(service.delete(INSTANCE_ID, USER_ID)).rejects.toMatchObject({
      code: "REDIS_INSTANCE_NOT_FOUND",
      statusCode: 404,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("RedisInstanceService.create (F5.30)", () => {
  it("creates the container, stores the encrypted password and audits without secrets", async () => {
    spawnMock.mockReturnValue(scriptResult(JSON.stringify({ success: true, container: CONTAINER }), 0));
    const { prisma, auditLog, service } = fixture({}, null);

    const input = {
      name: "shop_cache",
      image: "valkey/valkey:8.0" as const,
      evictionPolicy: "noeviction" as const,
      persistence: "RDB" as const,
      memoryLimitMb: 64,
      projectId: null,
      autoInjectEnv: true,
    };
    const result = await service.create(USER_ID, input);

    expect(result.connectionUrl).toContain(`@${CONTAINER}:6379`);
    expect(result.connectionUrl).toMatch(/^redis:\/\/:[A-Za-z0-9]{32}@/);
    expect(prisma.redisInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RUNNING",
          memoryLimitMb: 64,
          userId: USER_ID,
        }),
      }),
    );
    expect(auditLog.log).toHaveBeenCalledWith(
      USER_ID,
      "redis_instance.created",
      { type: "RedisInstance", id: INSTANCE_ID },
      expect.not.objectContaining({ after: expect.objectContaining({ password: expect.anything() }) }),
    );
  });

  it("refuses a memory limit above the admin cap", async () => {
    const { service } = fixture({}, null);

    await expect(
      service.create(USER_ID, {
        name: "shop_cache",
        image: "valkey/valkey:8.0",
        evictionPolicy: "noeviction",
        persistence: "RDB",
        memoryLimitMb: 99999,
        projectId: null,
        autoInjectEnv: true,
      }),
    ).rejects.toMatchObject({ code: "REDIS_MEMORY_LIMIT_TOO_HIGH", statusCode: 400 });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("RedisInstanceService.stats (F5.30)", () => {
  it("returns parsed INFO numbers and refuses when the instance is stopped", async () => {
    spawnMock.mockReturnValue(
      scriptResult(
        JSON.stringify({
          usedMemoryBytes: 1048576,
          usedMemoryPercent: 1.6,
          connectedClients: 2,
          totalKeys: 42,
          evictedKeys: 0,
          uptimeSeconds: 3600,
        }),
        0,
      ),
    );
    const { service } = fixture();

    await expect(service.stats(INSTANCE_ID, USER_ID)).resolves.toEqual({
      usedMemoryBytes: 1048576,
      usedMemoryPercent: 1.6,
      connectedClients: 2,
      totalKeys: 42,
      evictedKeys: 0,
      uptimeSeconds: 3600,
    });

    const { service: stoppedService } = fixture({ status: "STOPPED" });
    await expect(stoppedService.stats(INSTANCE_ID, USER_ID)).rejects.toMatchObject({
      code: "REDIS_NOT_RUNNING",
      statusCode: 409,
    });
  });
});

describe("RedisInstanceService.rotatePassword (F5.30)", () => {
  it("recreates the container with a new password and audits without the secret", async () => {
    spawnMock.mockReturnValue(scriptResult(JSON.stringify({ success: true }), 0));
    const { auditLog, prisma, service } = fixture();

    await service.rotatePassword(INSTANCE_ID, USER_ID);

    expect(prisma.redisInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ passwordEncrypted: "encrypted-ciphertext" }) }),
    );
    expect(auditLog.log).toHaveBeenCalledWith(
      USER_ID,
      "redis_instance.password_rotated",
      { type: "RedisInstance", id: INSTANCE_ID },
      expect.not.objectContaining({ after: expect.objectContaining({ password: expect.anything() }) }),
    );
  });
});
