import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { RegisterSchema, LoginSchema, ChangePasswordSchema, TwoFactorChallengeSchema, VerifyTotpSetupSchema, DisableTwoFactorSchema, ForgotPasswordSchema, ResetPasswordSchema } from "./schema.js";
import { AuthService, AuthError, prepareLoginDecoy } from "./service.js";
import { TwoFactorService } from "./two-factor-service.js";
import { PasswordResetService } from "./password-reset-service.js";
import { AuditLogService } from "../audit-log/service.js";
import { SESSION_COOKIE, createSession, destroySession, destroyUserSessions } from "../../plugins/auth.js";
import { env } from "../../config/env.js";


export async function authRoutes(app: FastifyInstance) {
  const service = new AuthService(app.prisma);
  // Warm the login decoy hash before any request is served (see #44).
  await prepareLoginDecoy();
  const twoFactor = new TwoFactorService(app.prisma, app.redis, new AuditLogService(app.prisma, app.log));
  const passwordReset = new PasswordResetService(app.prisma, app.redis, new AuditLogService(app.prisma, app.log));

  // Register rate limiting plugin for this scope
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });

  // POST /api/auth/register
  app.post("/register", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes",
      },
    },
    handler: async (request, reply) => {
      if (!env.ALLOW_REGISTRATION) {
        reply.status(403).send({
          error: "Registration is disabled",
          code: "REGISTRATION_DISABLED",
          details: {},
        });
        return;
      }

      try {
        const data = RegisterSchema.parse(request.body);
        const user = await service.register(data);

        await createSession(app, reply, user.id);

        reply.status(201).send({ user });
      } catch (err) {
        if (err instanceof AuthError) {
          reply.status(err.statusCode).send({
            error: err.message,
            code: err.code,
            details: {},
          });
          return;
        }
        throw err;
      }
    },
  });

  // POST /api/auth/login
  app.post("/login", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes",
      },
    },
    handler: async (request, reply) => {
      try {
        const data = LoginSchema.parse(request.body);
        const user = await service.login(data);

        const full = await app.prisma.user.findUnique({ where: { id: user.id } });
        if (full?.totpEnabled) {
          const challengeToken = await twoFactor.storeChallenge(user.id);
          reply.status(202).send({ requires2FA: true, challengeToken });
          return;
        }
        if (env.REQUIRE_ADMIN_2FA && user.role === "ADMIN" && !full?.totpEnabled) {
          reply.status(403).send({ error: "Admins must enable two-factor authentication", code: "ADMIN_2FA_REQUIRED", details: {} });
          return;
        }
        await createSession(app, reply, user.id);

        return { user };
      } catch (err) {
        if (err instanceof AuthError) {
          reply.status(err.statusCode).send({
            error: err.message,
            code: err.code,
            details: {},
          });
          return;
        }
        throw err;
      }
    },
  });

  // POST /api/auth/logout — no rate limit
  app.post("/logout", async (request, reply) => {
    await destroySession(app, request, reply);
    return { message: "Logged out" };
  });

  // GET /api/auth/me — no rate limit
  app.get(
    "/me",
    { preHandler: [app.requireAuth] },
    async (request) => {
      const user = await service.getCurrentUser(request.userId!);
      return { user };
    },
  );

  // POST /api/auth/change-password (F5.11) — self-service, requires the
  // current password. Rate-limited like login since it re-verifies a secret.
  app.post("/change-password", {
    preHandler: [app.requireAuth],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes",
      },
    },
    handler: async (request, reply) => {
      try {
        const data = ChangePasswordSchema.parse(request.body);
        await service.changePassword(request.userId!, data);
        // The caller stays signed in; every other session ends.
        await destroyUserSessions(app.prisma, app.redis, request.userId!, request.cookies[SESSION_COOKIE]);
        return { message: "Password changed" };
      } catch (err) {
        if (err instanceof AuthError) {
          reply.status(err.statusCode).send({
            error: err.message,
            code: err.code,
            details: {},
          });
          return;
        }
        throw err;
      }
    },
  });

  // POST /api/auth/forgot-password — always answers 202 with the same body,
  // whether or not the email belongs to an account, so it can't be used to
  // discover which emails are registered.
  app.post("/forgot-password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    handler: async (request, reply) => {
      const data = ForgotPasswordSchema.parse(request.body);
      try {
        await passwordReset.requestReset(data.email, request.ip);
      } catch (err) {
        app.log.error({ err }, "Password reset request failed");
      }
      reply.status(202);
      return { message: "If that email belongs to an account, a reset link is on its way." };
    },
  });

  // POST /api/auth/reset-password
  app.post("/reset-password", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    handler: async (request, reply) => {
      try {
        const data = ResetPasswordSchema.parse(request.body);
        await passwordReset.resetPassword(data.token, data.newPassword);
        return { message: "Password updated. You can now sign in." };
      } catch (err) {
        if (err instanceof AuthError) {
          reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
          return;
        }
        throw err;
      }
    },
  });

  // GET /api/auth/config — public, lets the dashboard know whether to show
  // the self-registration form/link (F5.8).
  app.get("/config", async () => {
    return { allowRegistration: env.ALLOW_REGISTRATION, requireAdmin2FA: env.REQUIRE_ADMIN_2FA };
  });

  app.post("/2fa/challenge", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    try {
      const data = TwoFactorChallengeSchema.parse(request.body);
      const userId = await twoFactor.peekChallenge(data.challengeToken);
      if (!userId) return reply.status(401).send({ error: "Invalid or expired code", code: "2FA_INVALID_CODE", details: {} });
      if (!(await twoFactor.verifyLoginCode(userId, data.code))) return reply.status(401).send({ error: "Invalid or expired code", code: "2FA_INVALID_CODE", details: {} });
      await twoFactor.deleteChallenge(data.challengeToken);
      const user = await service.getCurrentUser(userId);
      await createSession(app, reply, userId);
      return { user };
    } catch (err) {
      if (err instanceof AuthError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
        return;
      }
      throw err;
    }
  });

  app.post("/2fa/setup", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      return twoFactor.createSetup(request.userId!);
    } catch (err) {
      if (err instanceof AuthError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
        return;
      }
      throw err;
    }
  });

  app.post("/2fa/verify-setup", { preHandler: [app.requireAuth], config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
    try {
      const data = VerifyTotpSetupSchema.parse(request.body);
      return twoFactor.confirmSetup(request.userId!, data.code);
    } catch (err) {
      if (err instanceof AuthError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
        return;
      }
      throw err;
    }
  });

  app.post("/2fa/disable", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const data = DisableTwoFactorSchema.parse(request.body);
      await twoFactor.disable(request.userId!, data.password, data.codeOrRecovery);
      return { message: "Two-factor authentication disabled" };
    } catch (err) {
      if (err instanceof AuthError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
        return;
      }
      throw err;
    }
  });
}
