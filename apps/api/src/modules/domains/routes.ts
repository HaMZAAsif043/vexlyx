import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainService, DomainError } from "./service.js";
import { DnsService } from "./dns-service.js";
import { SslService } from "./ssl-service.js";
import { AuditLogService } from "../audit-log/service.js";
import {
  CreateDomainSchema,
  UpdateDomainSchema,
  DomainListQuerySchema,
  DomainIdParamSchema,
  DomainRecordParamSchema,
  VerifyDomainQuerySchema,
  CreateDnsRecordSchema,
  UpdateDnsRecordSchema,
  ImportZoneFileSchema,
  SetDnsModeSchema,
  UploadCertificateSchema,
  ProvisionSslSchema,
  UpdateSslSettingsSchema,
} from "./schema.js";

import { isZodError, handleZodError } from "../../plugins/error-handler.js";

function handleDomainError(err: unknown, reply: FastifyReply): void {
  if (err instanceof DomainError) {
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

export async function domainRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const service = new DomainService(app.prisma, auditLog);
  const dnsService = new DnsService(app.prisma, app.log);
  const sslService = new SslService(app.prisma);

  app.patch("/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = DomainIdParamSchema.parse(request.params);
      const input = UpdateDomainSchema.parse(request.body);
      return await service.update(request.userId!, id, input);
    } catch (err) {
      handleDomainError(err, reply);
    }
  });

  const requireManagedDns = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    try {
      const { id } = DomainIdParamSchema.parse(request.params);
      await dnsService.assertManaged(request.userId!, id);
    } catch (err) {
      handleDomainError(err, reply);
      return reply;
    }
  };

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns-mode/check — are the nameservers delegated to us?
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns-mode/check",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await dnsService.checkDelegation(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/domains/:id/dns-mode — switch CONNECTED <-> MANAGED
  // ---------------------------------------------------------------------------
  app.patch(
    "/:id/dns-mode",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const { mode, skipDelegationCheck } = SetDnsModeSchema.parse(request.body);
        const domain = await dnsService.setDnsMode(request.userId!, id, mode, skipDelegationCheck);
        await auditLog.log(request.userId!, "domain.dns_mode_changed", { type: "Domain", id }, {
          after: { dnsMode: domain.dnsMode },
        });
        return { id: domain.id, dnsMode: domain.dnsMode };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains — list domains
  // ---------------------------------------------------------------------------
  app.get(
    "/",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const query = DomainListQuerySchema.parse(request.query);
        return await service.list(request.userId!, query);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains — add domain to project (201 Created)
  // ---------------------------------------------------------------------------
  app.post(
    "/",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const input = CreateDomainSchema.parse(request.body);
        const result = await service.create(request.userId!, input);
        reply.status(201);
        return result;
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains/:id — get domain details
  // ---------------------------------------------------------------------------
  app.get(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await service.getById(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains/:id/subdomains — list all subdomains for a parent domain
  // ---------------------------------------------------------------------------
  app.get(
    "/:id/subdomains",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await service.listSubdomains(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );


  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/verify — trigger DNS TXT verification
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/verify",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const query = VerifyDomainQuerySchema.parse(request.query);
        return await service.verify(
          request.userId!,
          id,
          query.mockRecord,
          query.mock === "true",
        );
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/domains/:id — remove domain (204 No Content)
  // ---------------------------------------------------------------------------
  app.delete(
    "/:id",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        await service.delete(request.userId!, id);
        reply.status(204).send();
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains/:id/dns — list DNS records
  // ---------------------------------------------------------------------------
  app.get(
    "/:id/dns",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await dnsService.listRecords(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns — create a new DNS record (201 Created)
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const input = CreateDnsRecordSchema.parse(request.body);
        const record = await dnsService.createRecord(request.userId!, id, input);
        reply.status(201);
        return record;
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns/defaults — setup recommended DNS records
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns/defaults",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await dnsService.initializeDefaultRecords(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/domains/:id/dns/:recordId — update DNS record
  // ---------------------------------------------------------------------------
  app.patch(
    "/:id/dns/:recordId",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id, recordId } = DomainRecordParamSchema.parse(request.params);
        const input = UpdateDnsRecordSchema.parse(request.body);
        return await dnsService.updateRecord(request.userId!, id, recordId, input);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/domains/:id/dns/:recordId — delete DNS record (204 No Content)
  // ---------------------------------------------------------------------------
  app.delete(
    "/:id/dns/:recordId",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id, recordId } = DomainRecordParamSchema.parse(request.params);
        await dnsService.deleteRecord(request.userId!, id, recordId);
        reply.status(204).send();
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns/sync — rewrite the served zone from the database.
  // The retry path after DNS_ZONE_WRITE_FAILED: record changes are already
  // saved, so repeating them cannot repair a zone that failed to write.
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns/sync",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await dnsService.resyncZone(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains/:id/dns/export — export RFC 1035 zone file
  // ---------------------------------------------------------------------------
  app.get(
    "/:id/dns/export",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const zone = await dnsService.exportZoneFile(request.userId!, id);
        reply.header("Content-Disposition", `attachment; filename="${zone.filename}"`);
        reply.type("text/plain; charset=utf-8");
        return zone.content;
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns/import — import RFC 1035 zone file
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns/import",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const input = ImportZoneFileSchema.parse(request.body);
        return await dnsService.importZoneFile(
          request.userId!,
          id,
          input.zoneContent,
          input.strategy,
        );
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/dns/:recordId/propagation — check propagation status
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/dns/:recordId/propagation",
    { preHandler: [app.requireAuth, requireManagedDns] },
    async (request, reply) => {
      try {
        const { id, recordId } = DomainRecordParamSchema.parse(request.params);
        return await dnsService.checkPropagation(request.userId!, id, recordId);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ===========================================================================
  // SSL Certificate Management Endpoints (F3.4)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // GET /api/domains/ssl/alerts — audit all certificates for upcoming expiry (<= 7 days)
  // ---------------------------------------------------------------------------
  app.get(
    "/ssl/alerts",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        return await sslService.checkExpiryAlerts(request.userId!);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/domains/:id/ssl — get SSL certificate details & status
  // ---------------------------------------------------------------------------
  app.get(
    "/:id/ssl",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const cert = await sslService.getCertificate(request.userId!, id);
        return { certificate: cert };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/ssl/provision — provision Auto SSL (Let's Encrypt / Dev)
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/ssl/provision",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const input = ProvisionSslSchema.parse(request.body ?? {});
        const cert = await sslService.provisionAutoSsl(request.userId!, id, input);
        reply.status(201);
        return { certificate: cert };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/ssl/upload — upload custom SSL certificate & private key
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/ssl/upload",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const input = UploadCertificateSchema.parse(request.body);
        const cert = await sslService.uploadCustomCert(request.userId!, id, input);
        reply.status(201);
        return { certificate: cert };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/domains/:id/ssl/renew — force certificate renewal check
  // ---------------------------------------------------------------------------
  app.post(
    "/:id/ssl/renew",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const cert = await sslService.renewCertificate(request.userId!, id);
        return { certificate: cert };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/domains/:id/ssl/settings — update SSL settings (forceHttps, autoRenew)
  // ---------------------------------------------------------------------------
  app.patch(
    "/:id/ssl/settings",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        const input = UpdateSslSettingsSchema.parse(request.body);
        const cert = await sslService.updateSettings(request.userId!, id, input);
        return { certificate: cert };
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/domains/:id/ssl — disable SSL for domain
  // ---------------------------------------------------------------------------
  app.delete(
    "/:id/ssl",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = DomainIdParamSchema.parse(request.params);
        return await sslService.disableSsl(request.userId!, id);
      } catch (err) {
        handleDomainError(err, reply);
      }
    },
  );
}
