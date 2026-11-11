import { afterEach, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import * as argon2 from "argon2";

const { settings } = vi.hoisted(() => ({
  settings: {
    NODE_ENV: "production",
    ALLOW_REGISTRATION: true,
    REQUIRE_ADMIN_2FA: false,
    COOKIE_DOMAIN: ".example.test",
    SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
  },
}));
vi.mock("../../config/env.js", () => ({ env: settings }));
vi.mock("../system-email/notifier.js", () => ({ notifyUser: vi.fn() }));
vi.mock("../../plugins/socket.js", () => ({
  disconnectSessionSockets: vi.fn(),
}));
import { authSessionPlugin } from "../../plugins/auth.js";
import { errorHandlerPlugin } from "../../plugins/error-handler.js";
import { authRoutes } from "./routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  settings.ALLOW_REGISTRATION = true;
  settings.REQUIRE_ADMIN_2FA = false;
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const password = "correct-horse-battery-staple";
const registration = {
  name: "Ada",
  email: "ada@example.test",
  password,
  confirmPassword: password,
};
type User = {
  id: string;
  email: string;
  name: string;
  password: string;
  role: string;
  totpEnabled: boolean;
  resellerId: null;
  permissions: string[];
  createdAt: Date;
};
type Session = { id: string; userId: string; expiresAt: Date };

async function fixture() {
  const users: User[] = [];
  const sessions = new Map<string, Session>();
  const cache = new Map<string, string>();
  const prisma = {
    user: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id?: string; email?: string };
          select?: Record<string, boolean>;
        }) => {
          const user = users.find((user) =>
            where.id ? user.id === where.id : user.email === where.email,
          );
          if (!user) return null;
          return select
            ? Object.fromEntries(
                Object.keys(select)
                  .filter((key) => select[key])
                  .map((key) => [key, user[key as keyof User]]),
              )
            : { ...user };
        },
      ),
      count: vi.fn(async () => users.length),
      create: vi.fn(
        async ({
          data,
          select,
        }: {
          data: Pick<User, "name" | "email" | "password" | "role">;
          select: Record<string, boolean>;
        }) => {
          const user: User = {
            ...data,
            id: `u${users.length + 1}`,
            totpEnabled: false,
            resellerId: null,
            permissions: [],
            createdAt: new Date(),
          };
          users.push(user);
          return Object.fromEntries(
            Object.keys(select)
              .filter((key) => select[key])
              .map((key) => [key, user[key as keyof User]]),
          );
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<User>;
        }) =>
          Object.assign(
            users.find((user) => user.id === where.id)!,
            data,
          ),
      ),
    },
    session: {
      create: vi.fn(async ({ data }: { data: Session }) => {
        sessions.set(data.id, data);
        return data;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) =>
        sessions.delete(where.id),
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; id?: { not: string } };
        }) =>
          [...sessions.values()].filter(
            (session) =>
              session.userId === where.userId && session.id !== where.id?.not,
          ),
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] } } }) => {
          for (const id of where.id.in) sessions.delete(id);
        },
      ),
    },
  };
  const redis = {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      cache.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) count += Number(cache.delete(key));
      return count;
    }),
  };
  const app = Fastify();
  apps.push(app);
  await app.register(
    fp(
      async (instance) => {
        instance.decorate("prisma", prisma as never);
      },
      { name: "prisma" },
    ),
  );
  await app.register(
    fp(
      async (instance) => {
        instance.decorate("redis", redis as never);
      },
      { name: "redis" },
    ),
  );
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.ready();
  return { app, users, sessions, cache, prisma };
}

function cookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0]!;
}

it("runs register → login → me → password change → logout through real sessions and hashing", async () => {
  const { app, users, sessions } = await fixture();
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: registration,
  });
  expect(registered.statusCode).toBe(201);
  expect(registered.json().user).toMatchObject({
    role: "ADMIN",
    email: registration.email,
  });
  expect(registered.json().user).not.toHaveProperty("password");
  const header = String(registered.headers["set-cookie"]);
  for (const attribute of [
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Domain=.example.test",
    "Path=/",
  ])
    expect(header).toContain(attribute);
  expect(await argon2.verify(users[0]!.password, password)).toBe(true);
  const first = cookie(registered);
  const loggedIn = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: registration.email, password },
  });
  expect(loggedIn.statusCode).toBe(200);
  const other = cookie(loggedIn);
  expect(other).not.toBe(first);
  expect(sessions.size).toBe(2);
  const me = await app.inject({
    url: "/api/auth/me",
    headers: { cookie: first },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json().user.id).toBe(users[0]!.id);
  const change = {
    currentPassword: "wrong",
    newPassword: "a-different-long-password",
    confirmNewPassword: "a-different-long-password",
  };
  const denied = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { cookie: first },
    payload: change,
  });
  expect(denied.statusCode).toBe(401);
  expect(sessions.size).toBe(2);
  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { cookie: first },
    payload: { ...change, currentPassword: password },
  });
  expect(changed.statusCode).toBe(200);
  expect(await argon2.verify(users[0]!.password, change.newPassword)).toBe(
    true,
  );
  expect(await argon2.verify(users[0]!.password, password)).toBe(false);
  expect(
    (await app.inject({ url: "/api/auth/me", headers: { cookie: first } }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ url: "/api/auth/me", headers: { cookie: other } }))
      .statusCode,
  ).toBe(401);
  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: first },
  });
  expect(logout.statusCode).toBe(200);
  expect(String(logout.headers["set-cookie"])).toContain(
    "Domain=.example.test",
  );
  expect(sessions.size).toBe(0);
  expect(
    (await app.inject({ url: "/api/auth/me", headers: { cookie: first } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: registration.email, password },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: registration.email, password: change.newPassword },
      })
    ).statusCode,
  ).toBe(200);
});

it("promotes only the first account and ignores a later requested ADMIN role", async () => {
  const { app } = await fixture();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: registration,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { ...registration, email: "second@example.test", role: "ADMIN" },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().user.role).toBe("USER");
});

it("rejects duplicates without changing credentials or creating another session", async () => {
  const { app, users, sessions } = await fixture();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: registration,
  });
  const hash = users[0]!.password;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: registration,
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().code).toBe("EMAIL_EXISTS");
  expect(users[0]!.password).toBe(hash);
  expect(sessions.size).toBe(1);
  expect(response.headers["set-cookie"]).toBeUndefined();
});

it("blocks disabled registration and malformed registration before persistence", async () => {
  const { app, prisma } = await fixture();
  settings.ALLOW_REGISTRATION = false;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: registration,
      })
    ).statusCode,
  ).toBe(403);
  settings.ALLOW_REGISTRATION = true;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { ...registration, confirmPassword: "different" },
      })
    ).statusCode,
  ).toBe(400);
  expect(prisma.user.create).not.toHaveBeenCalled();
});

it.each(["/me", "/change-password"])(
  "rejects anonymous access to %s",
  async (path) => {
    const { app, prisma } = await fixture();
    const response = await app.inject({
      method: path === "/me" ? "GET" : "POST",
      url: `/api/auth${path}`,
    });
    expect(response.statusCode).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  },
);

it("returns indistinguishable unknown-user and wrong-password responses without new sessions", async () => {
  const { app, sessions } = await fixture();
  await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: registration,
  });
  const results = [];
  for (const email of [registration.email, "unknown@example.test"])
    results.push(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "incorrect" },
      }),
    );
  expect(results[0]!.statusCode).toBe(401);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect(sessions.size).toBe(1);
  expect(
    results.every((result) => result.headers["set-cookie"] === undefined),
  ).toBe(true);
});

it.each([true, false])(
  "does not create a login session before required 2FA (enabled=%s)",
  async (enabled) => {
    const { app, users, sessions } = await fixture();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: registration,
    });
    users[0]!.totpEnabled = enabled;
    settings.REQUIRE_ADMIN_2FA = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: registration.email, password },
    });
    expect(response.statusCode).toBe(enabled ? 202 : 403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(sessions.size).toBe(1);
  },
);
