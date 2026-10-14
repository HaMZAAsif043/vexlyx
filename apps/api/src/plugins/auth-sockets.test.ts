import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { disconnectMock } = vi.hoisted(() => ({ disconnectMock: vi.fn() }));
vi.mock("./socket.js", () => ({ disconnectSessionSockets: disconnectMock }));

const { destroySession, destroyUserSessions } = await import("./auth.js");

beforeEach(() => disconnectMock.mockReset());

describe("destroySession ends the session's live sockets (#64)", () => {
  function fixture(cookie: string | undefined) {
    const redis = { del: vi.fn().mockResolvedValue(1) };
    const prisma = { session: { delete: vi.fn().mockResolvedValue({}) } };
    const app = { redis, prisma } as unknown as FastifyInstance;
    const request = { cookies: cookie ? { vexlyx_session: cookie } : {} } as unknown as FastifyRequest;
    const reply = { clearCookie: vi.fn() } as unknown as FastifyReply;
    return { app, request, reply, redis, prisma };
  }

  it("disconnects the sockets opened with the destroyed session", async () => {
    const { app, request, reply, redis } = fixture("sess-1");

    await destroySession(app, request, reply);

    expect(redis.del).toHaveBeenCalledWith("session:sess-1");
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledWith("sess-1");
  });

  it("does nothing without a session cookie", async () => {
    const { app, request, reply, redis } = fixture(undefined);

    await destroySession(app, request, reply);

    expect(redis.del).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});

describe("destroyUserSessions ends those sessions' live sockets (#64)", () => {
  function fixture(rows: { id: string }[]) {
    const prisma = {
      session: {
        findMany: vi.fn().mockResolvedValue(rows),
        deleteMany: vi.fn().mockResolvedValue({ count: rows.length }),
      },
    } as unknown as PrismaClient;
    const redis = { del: vi.fn().mockResolvedValue(rows.length) };
    return { prisma, redis };
  }

  it("disconnects the sockets of every destroyed session", async () => {
    const { prisma, redis } = fixture([{ id: "a" }, { id: "b" }]);

    await destroyUserSessions(prisma, redis, "u1");

    expect(disconnectMock.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("leaves the spared (current) session's sockets alone", async () => {
    const { prisma, redis } = fixture([{ id: "other" }]);

    await destroyUserSessions(prisma, redis, "u1", "current");

    expect(prisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", id: { not: "current" } } }),
    );
    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledWith("other");
  });

  it("disconnects nothing when the user has no other sessions", async () => {
    const { prisma, redis } = fixture([]);

    await destroyUserSessions(prisma, redis, "u1", "current");

    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
