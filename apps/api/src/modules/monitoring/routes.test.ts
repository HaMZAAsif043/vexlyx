import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("../../plugins/socket.js", () => ({ getIO: () => ({}) }));
vi.mock("./socket.js", () => ({
  registerMonitoringSocketHandlers: vi.fn(),
  runMetricsCollectorJob: vi.fn(),
}));
vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({ upsertJobScheduler: vi.fn(async () => undefined) }),
  createWorker: () => ({}),
}));

// The REAL session/role guards (plugins/auth.ts) run in these tests, so a
// regression in cookie authentication or the database role check is caught.
const { authSessionPlugin } = await import("../../plugins/auth.js");
const { monitoringRoutes } = await import("./routes.js");
const { MonitoringService } = await import("./service.js");

afterEach(() => vi.restoreAllMocks());

type Role = "ADMIN" | "RESELLER" | "USER";

const SESSIONS: Record<string, string> = {
  "admin-session": "admin-1",
  "reseller-session": "reseller-1",
  "user-session": "user-1",
};

const ROLES: Record<string, Role> = {
  "admin-1": "ADMIN",
  "reseller-1": "RESELLER",
  "user-1": "USER",
};

async function appFixture() {
  const fakeRedis = fp(
    async (app) => {
      app.decorate("redis", {
        get: vi.fn(async (key: string) => {
          const userId = SESSIONS[key.replace("session:", "")];
          return userId
            ? JSON.stringify({ userId, expiresAt: Date.now() + 60_000 })
            : null;
        }),
        set: vi.fn(),
        del: vi.fn(),
      } as unknown as FastifyInstance["redis"]);
    },
    { name: "redis" },
  );

  const fakePrisma = fp(
    async (app) => {
      app.decorate("prisma", {
        user: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            const role = ROLES[where.id];
            return role ? { role, permissions: [] } : null;
          }),
        },
      } as unknown as FastifyInstance["prisma"]);
    },
    { name: "prisma" },
  );

  const app = Fastify();
  await app.register(fakeRedis);
  await app.register(fakePrisma);
  await app.register(authSessionPlugin);
  app.decorate("registerQueue", vi.fn() as unknown as FastifyInstance["registerQueue"]);
  await app.register(monitoringRoutes, { prefix: "/api/monitoring" });
  return app;
}

const cookie = (session: string) => ({ cookie: `vexlyx_session=${session}` });

const ENDPOINTS = [
  { url: "/api/monitoring/server", method: "getServerMetrics" as const, result: { cpuPercent: 1 } },
  { url: "/api/monitoring/containers", method: "getContainerMetrics" as const, result: [] },
  { url: "/api/monitoring/history?range=24h", method: "getHistory" as const, result: [] },
];

describe.each(ENDPOINTS)("GET $url", ({ url, method, result }) => {
  it("rejects unauthenticated requests with 401", async () => {
    const spy = vi.spyOn(MonitoringService.prototype, method);
    const app = await appFixture();
    try {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown or expired session cookie with 401", async () => {
    const spy = vi.spyOn(MonitoringService.prototype, method);
    const app = await appFixture();
    try {
      const res = await app.inject({ method: "GET", url, headers: cookie("not-a-session") });
      expect(res.statusCode).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["user-session", "reseller-session"])(
    "rejects non-admin (%s) with 403 and never touches host metrics",
    async (session) => {
      const spy = vi.spyOn(MonitoringService.prototype, method);
      const app = await appFixture();
      try {
        const res = await app.inject({ method: "GET", url, headers: cookie(session) });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("FORBIDDEN_ROLE");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("serves an admin", async () => {
    const spy = vi.spyOn(MonitoringService.prototype, method).mockResolvedValue(result as never);
    const app = await appFixture();
    try {
      const res = await app.inject({ method: "GET", url, headers: cookie("admin-session") });
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
