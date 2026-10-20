import { MailError } from "../mail/service.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { AliasService, AliasError } from "./service.js";
import {
  CreateAliasSchema,
  UpdateAliasDestinationsSchema,
  AliasListQuerySchema,
  AliasIdParamSchema,
} from "./schema.js";
import { isZodError, handleZodError } from "../../plugins/error-handler.js";

function handleAliasError(err: unknown, reply: FastifyReply): void {
  if (err instanceof MailError) {
    reply.log.error(
      { code: err.code, details: err.details },
      "Mail activation failed after a saved change",
    );
    reply
      .status(err.statusCode)
      .send({
        error:
          "The change was saved, but mail activation failed. Use Mail > Synchronize after correcting the service error. " +
          err.message,
        code: err.code,
        details: { ...err.details, databaseChanged: true },
      });
    return;
  }
  if (err instanceof AliasError) {
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      details: {},
    });
    return;
  }
  if (isZodError(err)) {
    const { statusCode, body } = handleZodError(err);
    reply.status(statusCode).send(body);
    return;
  }
  throw err;
}

export async function aliasRoutes(app: FastifyInstance) {
  const service = new AliasService(app.prisma, app.log);

  // ---------------------------------------------------------------------------
  // GET /api/aliases — list aliases (optionally filtered by domainId)
  // ---------------------------------------------------------------------------
  app.get("/", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const query = AliasListQuerySchema.parse(request.query);
      const aliases = await service.list(request.userId!, query);
      return reply.status(200).send({ aliases });
    } catch (err) {
      handleAliasError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/aliases — create alias (201 Created)
  // ---------------------------------------------------------------------------
  app.post("/", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const input = CreateAliasSchema.parse(request.body);
      const alias = await service.create(request.userId!, input);
      reply.status(201);
      return { alias };
    } catch (err) {
      handleAliasError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/aliases/:id/destinations — replace destination list
  // ---------------------------------------------------------------------------
  app.patch(
    "/:id/destinations",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = AliasIdParamSchema.parse(request.params);
        const input = UpdateAliasDestinationsSchema.parse(request.body);
        await service.updateDestinations(request.userId!, id, input);
        return reply.status(200).send({ success: true });
      } catch (err) {
        handleAliasError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/aliases/:id — delete alias (204 No Content)
  // ---------------------------------------------------------------------------
  app.delete(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = AliasIdParamSchema.parse(request.params);
        await service.delete(request.userId!, id);
        reply.status(204).send();
      } catch (err) {
        handleAliasError(err, reply);
      }
    },
  );
}
