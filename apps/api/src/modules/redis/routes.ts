import type { FastifyInstance, FastifyReply } from "fastify";
import {
  RedisInstanceService,
  RedisInstanceError,
} from "./service.js";
import {
  CreateRedisInstanceSchema,
  UpdateRedisInstanceSchema,
  RedisInstanceListQuerySchema,
  RedisInstanceIdParamSchema,
} from "./schema.js";
import { AuditLogService } from "../audit-log/service.js";

// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------

function handleRedisError(err: unknown, reply: FastifyReply): void {
  if (err instanceof RedisInstanceError) {
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      details: {},
    });
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Routes — /api/redis (F5.30)
// ---------------------------------------------------------------------------

export async function redisInstanceRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const service = new RedisInstanceService(app.prisma, auditLog);

  // GET /api/redis — list the user's instances (or all, for ADMIN via scope=all)
  app.get(
    "/",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const query = RedisInstanceListQuerySchema.parse(request.query);
        const scope = (request.query as { scope?: string }).scope;
        if (scope === "all") {
          if (request.userRole !== "ADMIN") {
            return reply.status(403).send({
              error: "Only administrators can list all Redis instances",
              code: "FORBIDDEN",
              details: {},
            });
          }
          return { instances: await service.listAll() };
        }
        return { instances: await service.list(request.userId!, query) };
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // POST /api/redis — create an instance → 201
  app.post(
    "/",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const input = CreateRedisInstanceSchema.parse(request.body);
        const result = await service.create(request.userId!, input);
        reply.status(201);
        return result;
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // GET /api/redis/:id — detail, including the connection URL (password revealed on demand)
  app.get(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = RedisInstanceIdParamSchema.parse(request.params);
        return await service.get(id, request.userId!, request.userRole === "ADMIN");
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // PATCH /api/redis/:id — change memory limit / eviction policy / persistence
  app.patch(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = RedisInstanceIdParamSchema.parse(request.params);
        const input = UpdateRedisInstanceSchema.parse(request.body);
        return await service.update(id, request.userId!, input, request.userRole === "ADMIN");
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // POST /api/redis/:id/start | /stop | /restart
  for (const action of ["start", "stop", "restart"] as const) {
    app.post(
      `/:id/${action}`,
      { preHandler: [app.requireAuth] },
      async (request, reply) => {
        try {
          const { id } = RedisInstanceIdParamSchema.parse(request.params);
          return await service[action](id, request.userId!, request.userRole === "ADMIN");
        } catch (err) {
          handleRedisError(err, reply);
        }
      },
    );
  }

  // POST /api/redis/:id/rotate-password — returns the detail with the new URL
  app.post(
    "/:id/rotate-password",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = RedisInstanceIdParamSchema.parse(request.params);
        return await service.rotatePassword(id, request.userId!, request.userRole === "ADMIN");
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // GET /api/redis/:id/stats — live usage from INFO (memory, keys, clients, uptime)
  app.get(
    "/:id/stats",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = RedisInstanceIdParamSchema.parse(request.params);
        return await service.stats(id, request.userId!, request.userRole === "ADMIN");
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );

  // DELETE /api/redis/:id — remove container + volume, then the record → 204
  app.delete(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = RedisInstanceIdParamSchema.parse(request.params);
        await service.delete(id, request.userId!, request.userRole === "ADMIN");
        reply.status(204).send();
      } catch (err) {
        handleRedisError(err, reply);
      }
    },
  );
}
