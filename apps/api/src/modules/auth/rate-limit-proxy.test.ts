import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

async function buildApp(trustProxy: string[] | false) {
  const { authRoutes } = await import("./routes.js");
  const app = Fastify({ trustProxy });
  app.decorate("prisma", { user: { findUnique: vi.fn(async () => null) } } as never);
  app.decorate("redis", { get: vi.fn(async () => null), set: vi.fn(async () => "OK"), del: vi.fn() } as never);
  app.decorate("requireAuth", vi.fn() as never);
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function login(app: TestApp, forwardedFor?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    payload: { email: "ada@example.com", password: "wrong-password-1" },
  });
  return res.statusCode;
}

async function exhaust(app: TestApp, forwardedFor?: string) {
  for (let i = 0; i < 5; i++) await login(app, forwardedFor);
}

describe("auth rate limit behind a proxy (#63)", () => {
  it("gives each client IP its own bucket when the proxy peer is trusted", async () => {
    const app = await buildApp(["loopback"]);

    await exhaust(app, "203.0.113.10");

    expect(await login(app, "203.0.113.10")).toBe(429);
    expect(await login(app, "203.0.113.20")).toBe(401);
  }, 30_000);

  it("still returns 429 to the same client after five attempts", async () => {
    const app = await buildApp(["loopback"]);

    await exhaust(app, "203.0.113.30");

    expect(await login(app, "203.0.113.30")).toBe(429);
  }, 30_000);

  it("ignores a forged leading X-Forwarded-For entry", async () => {
    const app = await buildApp(["loopback"]);

    // The proxy appends the real peer last; the client controls only what comes before it.
    await exhaust(app, "1.1.1.1, 203.0.113.40");

    expect(await login(app, "2.2.2.2, 203.0.113.40")).toBe(429);
  }, 30_000);

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    const app = await buildApp(["10.0.0.0/8"]);

    await exhaust(app, "203.0.113.70");

    expect(await login(app, "203.0.113.80")).toBe(429);
  }, 30_000);

  it("shares one bucket for every caller when no proxy is trusted", async () => {
    const app = await buildApp(false);

    await exhaust(app, "203.0.113.50");

    expect(await login(app, "203.0.113.60")).toBe(429);
  }, 30_000);
});
