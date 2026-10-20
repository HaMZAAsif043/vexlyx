import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";

// config/env.ts validates process.env eagerly at import time, so these must
// be set before auth.ts (which imports it) is loaded — a plain top-level
// import would be hoisted ahead of any assignment here.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { authSessionPlugin } = await import("./auth.js");

// Minimal stand-ins for the real redis/prisma plugins (named "redis"/"prisma"
// since authSessionPlugin declares them as fastify-plugin dependencies), so
// this test never touches a real database or Redis instance.
async function buildApp(options: { sessionUserId: string | null; findUniqueResult: unknown }) {
  const findUnique = vi.fn().mockResolvedValue(options.findUniqueResult);

  const fakeRedis = fp(
    async (app) => {
      app.decorate("redis", {
        get: vi.fn().mockResolvedValue(
          options.sessionUserId
            ? JSON.stringify({ userId: options.sessionUserId, expiresAt: Date.now() + 60_000 })
            : null,
        ),
        set: vi.fn(),
        del: vi.fn(),
      } as unknown as import("fastify").FastifyInstance["redis"]);
    },
    { name: "redis" },
  );

  const fakePrisma = fp(
    async (app) => {
      app.decorate("prisma", {
        user: { findUnique },
      } as unknown as import("fastify").FastifyInstance["prisma"]);
    },
    { name: "prisma" },
  );

  const app = Fastify();
  // Decorators added inside a plugin only become visible on `app` once that
  // plugin's registration promise resolves, so each register() must be
  // awaited before the route below can reference app.requireRoleOrPermission.
  await app.register(fakeRedis);
  await app.register(fakePrisma);
  await app.register(authSessionPlugin);

  app.get(
    "/protected",
    { preHandler: [app.requireRoleOrPermission(["ADMIN"], "canManageDns")] },
    async () => ({ ok: true }),
  );

  // Regression guard: requireAuth must be decorated by the plugin itself.
  // If it ever goes missing again, every route using it fails registration
  // (FST_ERR_HOOK_INVALID_HANDLER) and the API cannot boot.
  app.get(
    "/auth-only",
    { preHandler: [app.requireAuth] },
    async () => ({ ok: true }),
  );

  return { app, findUnique };
}

const SESSION_COOKIE = "vexlyx_session";
const withSession = { cookies: { [SESSION_COOKIE]: "test-session-id" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAuth", () => {
  it("is decorated by the plugin (a missing decorator breaks every protected route at boot)", async () => {
    const { app } = await buildApp({ sessionUserId: null, findUniqueResult: null });
    expect(typeof app.requireAuth).toBe("function");
  });

  it("returns 401 when there is no session", async () => {
    const { app } = await buildApp({ sessionUserId: null, findUniqueResult: null });
    const res = await app.inject({ method: "GET", url: "/auth-only" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows a signed-in user without any role lookup", async () => {
    const { app } = await buildApp({ sessionUserId: "user-1", findUniqueResult: null });
    const res = await app.inject({ method: "GET", url: "/auth-only", ...withSession });
    expect(res.statusCode).toBe(200);
  });
});

describe("requireRoleOrPermission", () => {
  it("returns 401 when there is no session", async () => {
    const { app } = await buildApp({ sessionUserId: null, findUniqueResult: null });
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("allows a user whose role is in the allowed list, without needing the permission", async () => {
    const { app } = await buildApp({
      sessionUserId: "admin-1",
      findUniqueResult: { role: "ADMIN", permissions: [] },
    });
    const res = await app.inject({ method: "GET", url: "/protected", ...withSession });
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 for a user with neither the role nor the permission", async () => {
    const { app } = await buildApp({
      sessionUserId: "user-1",
      findUniqueResult: { role: "USER", permissions: [] },
    });
    const res = await app.inject({ method: "GET", url: "/protected", ...withSession });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN_ROLE" });
  });

  it("allows a USER who lacks the role but was individually granted the permission", async () => {
    const { app } = await buildApp({
      sessionUserId: "user-1",
      findUniqueResult: { role: "USER", permissions: ["canManageDns"] },
    });
    const res = await app.inject({ method: "GET", url: "/protected", ...withSession });
    expect(res.statusCode).toBe(200);
  });

  it("re-checks the database on every request, so a revoked permission is enforced immediately", async () => {
    const { app, findUnique } = await buildApp({
      sessionUserId: "user-1",
      findUniqueResult: { role: "USER", permissions: ["canManageDns"] },
    });

    const first = await app.inject({ method: "GET", url: "/protected", ...withSession });
    expect(first.statusCode).toBe(200);

    findUnique.mockResolvedValue({ role: "USER", permissions: [] });

    const second = await app.inject({ method: "GET", url: "/protected", ...withSession });
    expect(second.statusCode).toBe(403);
  });
});
