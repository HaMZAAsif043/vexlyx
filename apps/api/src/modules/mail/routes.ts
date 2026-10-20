import type { FastifyInstance, FastifyReply } from "fastify";
import { MailService, MailError } from "./service.js";
import { DomainError } from "../domains/service.js";
import {
  SendTestEmailSchema,
  MailDomainParamSchema,
  QueueIdParamSchema,
  DeliveryLogFilterSchema,
} from "./schema.js";
import { isZodError, handleZodError } from "../../plugins/error-handler.js";

function handleMailError(err: unknown, reply: FastifyReply): void {
  if (err instanceof MailError || err instanceof DomainError) {
    if (err.statusCode >= 500)
      reply.log.error(
        {
          code: err.code,
          details: err instanceof MailError ? err.details : undefined,
        },
        "Mail synchronization failed",
      );
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      details: err instanceof MailError ? err.details : {},
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

export async function mailRoutes(app: FastifyInstance) {
  const service = new MailService(app.prisma, app.log);

  // ---------------------------------------------------------------------------
  // GET /api/mail/status — SMTP Server & Port Diagnostics
  // ---------------------------------------------------------------------------
  app.get(
    "/status",
    { preHandler: [app.requireAuth] },
    async (_request, reply) => {
      try {
        const status = await service.getStatus();
        return reply.status(200).send(status);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/domains — List Virtual Domains & DKIM state
  // ---------------------------------------------------------------------------
  app.get(
    "/domains",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const domains = await service.listVirtualDomains(request.userId!);
        return reply.status(200).send({ domains });
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/sync — Synchronize virtual domains from DB to Postfix
  // ---------------------------------------------------------------------------
  app.post(
    "/sync",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const result = await service.syncVirtualDomains(request.userId!);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/dkim/:domainId — Generate or retrieve DKIM record
  // ---------------------------------------------------------------------------
  app.post(
    "/dkim/:domainId",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { domainId } = MailDomainParamSchema.parse(request.params);
        const result = await service.getOrGenerateDkim(
          request.userId!,
          domainId,
        );
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/auth/:domainId/regenerate — Regenerate SPF/DKIM/DMARC/MX
  // ---------------------------------------------------------------------------
  app.post(
    "/auth/:domainId/regenerate",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { domainId } = MailDomainParamSchema.parse(request.params);
        const result = await service.ensureEmailAuthRecords(
          request.userId!,
          domainId,
        );
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/auth/:domainId/check — Re-check deliverability (live DNS for CONNECTED domains)
  // ---------------------------------------------------------------------------
  app.post(
    "/auth/:domainId/check",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { domainId } = MailDomainParamSchema.parse(request.params);
        const result = await service.getMailAuthStatus(
          request.userId!,
          domainId,
        );
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/test-send — Send test email with TLS handshake verification
  // ---------------------------------------------------------------------------
  app.post(
    "/test-send",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const parsedBody = SendTestEmailSchema.parse(request.body);
        const result = await service.sendTestEmail(request.userId!, parsedBody);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/webmail/status — Roundcube webmail container health
  // ---------------------------------------------------------------------------
  app.get(
    "/webmail/status",
    { preHandler: [app.requireAuth] },
    async (_request, reply) => {
      try {
        const status = await service.getWebmailStatus();
        return reply.status(200).send(status);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/test-relay — Probe open relay restriction
  // ---------------------------------------------------------------------------
  app.get(
    "/test-relay",
    { preHandler: [app.requireAuth] },
    async (_request, reply) => {
      try {
        const result = await service.testOpenRelay();
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/queue — List the Postfix mail queue (F4.8, ADMIN only —
  // server-wide across all tenants)
  // ---------------------------------------------------------------------------
  app.get(
    "/queue",
    { preHandler: [app.requireRole("ADMIN")] },
    async (_request, reply) => {
      try {
        const result = await service.listQueue();
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/queue/:queueId/delete — Delete a queued message (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/queue/:queueId/delete",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      try {
        const { queueId } = QueueIdParamSchema.parse(request.params);
        const result = await service.deleteQueueMessage(queueId);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/queue/flush — Flush the entire queue (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/queue/flush",
    { preHandler: [app.requireRole("ADMIN")] },
    async (_request, reply) => {
      try {
        const result = await service.flushQueue();
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/queue/:queueId/flush — Requeue one message immediately (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/queue/:queueId/flush",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      try {
        const { queueId } = QueueIdParamSchema.parse(request.params);
        const result = await service.flushQueue(queueId);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/queue/:queueId/hold — Hold a queued message (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/queue/:queueId/hold",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      try {
        const { queueId } = QueueIdParamSchema.parse(request.params);
        const result = await service.holdQueueMessage(queueId);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/queue/:queueId/release — Release a held message (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/queue/:queueId/release",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      try {
        const { queueId } = QueueIdParamSchema.parse(request.params);
        const result = await service.releaseQueueMessage(queueId);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/logs — Delivery/bounce log (F4.8, ADMIN only — server-wide
  // across all tenants)
  // ---------------------------------------------------------------------------
  app.get(
    "/logs",
    { preHandler: [app.requireRole("ADMIN")] },
    async (request, reply) => {
      try {
        const filter = DeliveryLogFilterSchema.parse(request.query);
        const result = await service.getDeliveryLog(filter);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/mail/dkim/:domainId/rotate — Rotate a domain's DKIM key (F4.8)
  // ---------------------------------------------------------------------------
  app.post(
    "/dkim/:domainId/rotate",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { domainId } = MailDomainParamSchema.parse(request.params);
        const result = await service.rotateDkim(request.userId!, domainId);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/mail/webmail/activity — Recent Roundcube login activity (F4.8)
  // ---------------------------------------------------------------------------
  app.get(
    "/webmail/activity",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const result = await service.getWebmailActivity(request.userId!);
        return reply.status(200).send(result);
      } catch (err) {
        handleMailError(err, reply);
      }
    },
  );
}
