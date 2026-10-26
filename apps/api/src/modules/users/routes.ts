import type { FastifyInstance, FastifyReply } from "fastify";
import { UserService, UserError } from "./service.js";
import { AuthError } from "../auth/service.js";
import { AuditLogService } from "../audit-log/service.js";
import { disconnectUserSockets } from "../../plugins/socket.js";
import { destroyUserSessions } from "../../plugins/auth.js";
import { TwoFactorService } from "../auth/two-factor-service.js";
import { RedisInstanceService } from "../redis/service.js";
import {
  CreateSubAccountSchema,
  UpdateUserRoleSchema,
  UpdateUserQuotasSchema,
  UpdateUserPermissionsSchema,
  UserIdParamSchema,
} from "./schema.js";

function handleUserError(err: unknown, reply: FastifyReply): void {
  if (err instanceof UserError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  throw err;
}

async function twoFactorAdminReset(app: FastifyInstance, actorId: string, targetId: string) {
  const svc = new TwoFactorService(app.prisma, app.redis, new AuditLogService(app.prisma, app.log));
  await svc.adminReset(actorId, targetId);
}

export async function userRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const redisInstances = new RedisInstanceService(app.prisma, auditLog);
  const service = new UserService(
    app.prisma,
    auditLog,
    disconnectUserSockets,
    (userId) => destroyUserSessions(app.prisma, app.redis, userId),
    (userId) => redisInstances.teardownAllForUser(userId),
  );

  // GET /api/users/me/usage — any authenticated user, their own quota/usage
  // breakdown (the "Your Plan" dashboard widget).
  app.get("/me/usage", { preHandler: [app.requireAuth] }, async (request) => {
    return service.getUsageSummary(request.userId!);
  });

  // GET /api/users — ADMIN sees everyone, RESELLER sees self + sub-accounts
  app.get("/", { preHandler: [app.requireRole("ADMIN", "RESELLER")] }, async (request, reply) => {
    try {
      return await service.list({ id: request.userId!, role: request.userRole! });
    } catch (err) {
      handleUserError(err, reply);
    }
  });

  // POST /api/users — ADMIN creates a user of any role, RESELLER creates a
  // sub-account, or a USER granted canCreateSubAccounts (F5.19)
  app.post(
    "/",
    { preHandler: [app.requireRoleOrPermission(["ADMIN", "RESELLER"], "canCreateSubAccounts")] },
    async (request, reply) => {
      try {
        const body = CreateSubAccountSchema.parse(request.body);
        const user = await service.createSubAccount({ id: request.userId!, role: request.userRole! }, body);
        reply.status(201);
        return user;
      } catch (err) {
        handleUserError(err, reply);
      }
    },
  );

  // PATCH /api/users/:id/role — ADMIN only
  app.patch("/:id/role", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      const { id } = UserIdParamSchema.parse(request.params);
      const body = UpdateUserRoleSchema.parse(request.body);
      return await service.updateRole({ id: request.userId!, role: request.userRole! }, id, body);
    } catch (err) {
      handleUserError(err, reply);
    }
  });

  // POST /api/users/:id/2fa/reset — ADMIN only (F5.17)
  app.post("/:id/2fa/reset", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      const { id } = UserIdParamSchema.parse(request.params);
      await twoFactorAdminReset(app, request.userId!, id);
      return { message: "Two-factor authentication reset" };
    } catch (err) {
      if (err instanceof AuthError) {
        reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
        return;
      }
      handleUserError(err, reply);
    }
  });

  // PATCH /api/users/:id/quotas — ADMIN (any user) or RESELLER (own sub-accounts only)
  app.patch("/:id/quotas", { preHandler: [app.requireRole("ADMIN", "RESELLER")] }, async (request, reply) => {
    try {
      const { id } = UserIdParamSchema.parse(request.params);
      const body = UpdateUserQuotasSchema.parse(request.body);
      return await service.updateQuotas({ id: request.userId!, role: request.userRole! }, id, body);
    } catch (err) {
      handleUserError(err, reply);
    }
  });

  // PATCH /api/users/:id/permissions — ADMIN only (F5.19)
  app.patch("/:id/permissions", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      const { id } = UserIdParamSchema.parse(request.params);
      const body = UpdateUserPermissionsSchema.parse(request.body);
      return await service.updatePermissions({ id: request.userId!, role: request.userRole! }, id, body);
    } catch (err) {
      handleUserError(err, reply);
    }
  });

  // DELETE /api/users/:id — ADMIN (any user) or RESELLER (own sub-accounts only)
  app.delete("/:id", { preHandler: [app.requireRole("ADMIN", "RESELLER")] }, async (request, reply) => {
    try {
      const { id } = UserIdParamSchema.parse(request.params);
      await service.delete({ id: request.userId!, role: request.userRole! }, id);
      reply.status(204);
      return null;
    } catch (err) {
      handleUserError(err, reply);
    }
  });
}
