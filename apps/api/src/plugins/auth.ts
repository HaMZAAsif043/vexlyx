import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import crypto from "node:crypto";
import type { Role, Permission, PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { disconnectSessionSockets } from "./socket.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
    userRole: Role | null;
    userResellerId: string | null;
  }
  interface FastifyInstance {
    requireAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    requireRole: (
      ...roles: Role[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRoleOrPermission: (
      roles: Role[],
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

interface SessionData {
  userId: string;
  expiresAt: number;
}

export const SESSION_COOKIE = "vexlyx_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

function sessionKey(id: string) {
  return `session:${id}`;
}

async function authPlugin(app: FastifyInstance) {
  await app.register(import("@fastify/cookie"));

  app.decorateRequest("userId", null);
  app.decorateRequest("userRole", null);
  app.decorateRequest("userResellerId", null);

  // On every request, check for session cookie and populate request.userId
  app.addHook("onRequest", async (request) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) return;

    const raw = await app.redis.get(sessionKey(sessionId));
    if (!raw) return;

    try {
      const session: SessionData = JSON.parse(raw);

      if (Date.now() > session.expiresAt) {
        await app.redis.del(sessionKey(sessionId));
        return;
      }

      request.userId = session.userId;
    } catch {
      await app.redis.del(sessionKey(sessionId));
    }
  });

  // Populate userRole and userResellerId on each authenticated request
  app.addHook("preHandler", async (request) => {
    if (!request.userId) return;

    const user = await app.prisma.user.findUnique({
      where: { id: request.userId },
      select: { role: true, resellerId: true },
    });

    if (user) {
      request.userRole = user.role;
      request.userResellerId = user.resellerId;
    }
  });

  // Shared preHandler hook to require authentication. The session itself was
  // already validated by the onRequest hook above, so this is a pure
  // "is there a signed-in user" check — no extra DB lookup needed.
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.userId) {
      return reply.status(401).send({
        error: "Authentication required",
        code: "UNAUTHORIZED",
        details: {},
      });
    }
  };

  app.decorate("requireAuth", requireAuth);

  // Shared preHandler factory to require one of a set of roles. Looked up
  // fresh from Postgres (not the session) on every call so a role change
  // made via the admin UI takes effect immediately, without needing to
  // invalidate the caller's existing session.
  const requireRole =
    (...roles: Role[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.userId) {
        return reply.status(401).send({
          error: "Authentication required",
          code: "UNAUTHORIZED",
          details: {},
        });
      }

      const user = await app.prisma.user.findUnique({
        where: { id: request.userId },
        select: { role: true, resellerId: true },
      });

      if (!user || !roles.includes(user.role)) {
        return reply.status(403).send({
          error: "You do not have permission to perform this action",
          code: "FORBIDDEN_ROLE",
          details: {},
        });
      }

      request.userRole = user.role;
      request.userResellerId = user.resellerId;
    };

  app.decorate("requireRole", requireRole);

  // Shared preHandler factory: grants access to a fixed set of roles OR a
  // user who's been individually granted `permission` (F5.19). Permissions
  // are additive only — they never take away what a role already grants —
  // so this is a superset check, not a replacement for requireRole. Same
  // fresh-lookup-per-request pattern as requireRole above, for the same
  // instant-revocation reason.
  const requireRoleOrPermission =
    (roles: Role[], permission: Permission) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.userId) {
        return reply.status(401).send({
          error: "Authentication required",
          code: "UNAUTHORIZED",
          details: {},
        });
      }

      const user = await app.prisma.user.findUnique({
        where: { id: request.userId },
        select: { role: true, permissions: true, resellerId: true },
      });

      if (!user || (!roles.includes(user.role) && !user.permissions.includes(permission))) {
        return reply.status(403).send({
          error: "You do not have permission to perform this action",
          code: "FORBIDDEN_ROLE",
          details: {},
        });
      }

      request.userRole = user.role;
      request.userResellerId = user.resellerId;
    };

  app.decorate("requireRoleOrPermission", requireRoleOrPermission);
}

export const authSessionPlugin = fp(authPlugin, {
  name: "auth",
  dependencies: ["redis", "prisma"],
});

// --- Session helpers used by auth routes ---

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;

  const sessionData: SessionData = { userId, expiresAt };

  await app.redis.set(
    sessionKey(sessionId),
    JSON.stringify(sessionData),
    "EX",
    SESSION_TTL_SECONDS,
  );

  // Also store in PostgreSQL for audit trail
  await app.prisma.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt: new Date(expiresAt),
    },
  });

  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });

  return sessionId;
}

export async function destroySession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (!sessionId) return;

  await app.redis.del(sessionKey(sessionId));

  // End the live streams opened with this session now, instead of leaving
  // them attached to a logged-out identity until the page is reloaded (#64).
  disconnectSessionSockets(sessionId);

  // Remove from PostgreSQL as well
  await app.prisma.session.delete({ where: { id: sessionId } }).catch(() => {
    // Session may already have been cleaned up
  });

  // Must match the Domain the cookie was set with (createSession above) —
  // otherwise this clears a different (host-only) cookie and leaves the
  // real, domain-scoped session cookie in the browser untouched.
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

/**
 * Ends every session of one user (Redis entry + Postgres row), optionally
 * sparing the caller's current session. Used after a password change or
 * reset so a stolen or forgotten login can't outlive the old password.
 */
export async function destroyUserSessions(
  prisma: PrismaClient,
  redis: { del(...keys: string[]): Promise<unknown> },
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const sessions = await prisma.session.findMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    select: { id: true },
  });
  if (sessions.length === 0) return;

  await redis.del(...sessions.map((session) => sessionKey(session.id)));
  for (const session of sessions) disconnectSessionSockets(session.id);
  await prisma.session.deleteMany({ where: { id: { in: sessions.map((session) => session.id) } } });
}
