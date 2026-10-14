import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { DatabaseService, DatabaseError } = await import("./service.js");

const USER_ID = "u1";
const DB_ID = "db1";

/** Fake database_manager.py process: writes `stdout` then exits with `code`. */
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

function fixture() {
  const record = {
    id: DB_ID,
    userId: USER_ID,
    name: "shop_db",
    type: "POSTGRESQL",
    dbUser: "shop_user",
  };
  const prisma = {
    database: {
      findUnique: vi.fn().mockResolvedValue(record),
      delete: vi.fn().mockResolvedValue(record),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new DatabaseService(
    prisma as unknown as PrismaClient,
    auditLog as never,
  );
  return { prisma, auditLog, service };
}

beforeEach(() => spawnMock.mockReset());

describe("DatabaseService.delete (#48)", () => {
  it("drops the database, deletes the record and audits it once the engine confirms", async () => {
    spawnMock.mockReturnValue(scriptResult(JSON.stringify({ success: true }), 0));
    const { prisma, auditLog, service } = fixture();

    await expect(service.delete(USER_ID, DB_ID)).resolves.toEqual({ success: true, id: DB_ID });

    expect(prisma.database.delete).toHaveBeenCalledWith({ where: { id: DB_ID } });
    expect(auditLog.log).toHaveBeenCalledWith(
      USER_ID,
      "database.deleted",
      { type: "Database", id: DB_ID },
      expect.anything(),
    );
  });

  it("keeps the record and writes no audit event when the engine drop fails", async () => {
    spawnMock.mockReturnValue(
      scriptResult(
        JSON.stringify({ error: "Failed to drop PostgreSQL database: connection refused", code: "PG_DROP_DB_FAILED" }),
        1,
      ),
    );
    const { prisma, auditLog, service } = fixture();

    const err = await service.delete(USER_ID, DB_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toMatchObject({ code: "DATABASE_DROP_FAILED", statusCode: 502 });
    expect((err as Error).message).toContain("shop_db");
    expect((err as Error).message).toContain("connection refused");
    expect(prisma.database.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("keeps the record when the script produces no output", async () => {
    spawnMock.mockReturnValue(scriptResult("", 1));
    const { prisma, auditLog, service } = fixture();

    await expect(service.delete(USER_ID, DB_ID)).rejects.toMatchObject({
      code: "DATABASE_DROP_FAILED",
    });
    expect(prisma.database.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("keeps the record when the script cannot be spawned", async () => {
    const child = scriptResult("", 0);
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn python3 ENOENT")));
      return child;
    });
    const { prisma, auditLog, service } = fixture();

    await expect(service.delete(USER_ID, DB_ID)).rejects.toMatchObject({
      code: "DATABASE_DROP_FAILED",
    });
    expect(prisma.database.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("returns 404 and runs nothing for another user's database", async () => {
    const { prisma, service } = fixture();
    prisma.database.findUnique.mockResolvedValue({ id: DB_ID, userId: "someone-else" });

    await expect(service.delete(USER_ID, DB_ID)).rejects.toMatchObject({
      code: "DATABASE_NOT_FOUND",
      statusCode: 404,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(prisma.database.delete).not.toHaveBeenCalled();
  });
});
