import { MailError } from "../mail/service.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { MailboxService, MailboxError } from "./service.js";
import { AuditLogService } from "../audit-log/service.js";
import {
  CreateMailboxSchema,
  UpdateMailboxQuotaSchema,
  MailboxListQuerySchema,
  MailboxIdParamSchema,
} from "./schema.js";
import { isZodError, handleZodError } from "../../plugins/error-handler.js";

function handleMailboxError(err: unknown, reply: FastifyReply): void {
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
  if (err instanceof MailboxError) {
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

export async function mailboxRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const service = new MailboxService(app.prisma, auditLog, app.log);

  // ---------------------------------------------------------------------------
  // GET /api/mailboxes — list mailboxes (optionally filtered by domainId)
  // ---------------------------------------------------------------------------
  app.get("/", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const query = MailboxListQuerySchema.parse(request.query);
      const mailboxes = await service.list(request.userId!, query);
      return reply.status(200).send({ mailboxes });
    } catch (err) {
      handleMailboxError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/mailboxes — create mailbox (201 Created)
  // ---------------------------------------------------------------------------
  app.post("/", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const input = CreateMailboxSchema.parse(request.body);
      const result = await service.create(request.userId!, input);
      reply.status(201);
      return result;
    } catch (err) {
      handleMailboxError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/mailboxes/:id — delete mailbox (204 No Content)
  // ---------------------------------------------------------------------------
  app.delete(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = MailboxIdParamSchema.parse(request.params);
        const { warnings } = await service.delete(request.userId!, id);
        if (warnings.length > 0) {
          return reply.status(200).send({ success: true, warnings });
        }
        reply.status(204).send();
      } catch (err) {
        handleMailboxError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/mailboxes/:id/quota — update mailbox quota
  // ---------------------------------------------------------------------------
  app.patch(
    "/:id/quota",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = MailboxIdParamSchema.parse(request.params);
        const input = UpdateMailboxQuotaSchema.parse(request.body);
        const { warnings } = await service.updateQuota(request.userId!, id, input);
        return reply
          .status(200)
          .send({ success: true, ...(warnings.length > 0 && { warnings }) });
      } catch (err) {
        handleMailboxError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mailboxes/:id/reset-password — generate and apply a new password
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/reset-password",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = MailboxIdParamSchema.parse(request.params);
        const result = await service.resetPassword(request.userId!, id);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailboxError(err, reply);
      }
    },
  );
}
