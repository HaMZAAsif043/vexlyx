import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("../../plugins/socket.js", () => ({ getIO: () => ({}) }));
vi.mock("../backups/socket.js", () => ({ registerBackupSocketHandlers: vi.fn() }));
vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({ upsertJobScheduler: vi.fn(async () => undefined) }),
  createWorker: () => ({}),
}));

const { DomainError } = await import("./service.js");
const { DnsService } = await import("./dns-service.js");
const { domainRoutes } = await import("./routes.js");
const { mailRoutes } = await import("../mail/routes.js");
const { MailService } = await import("../mail/service.js");
const { backupRoutes } = await import("../backups/routes.js");
const { BackupService } = await import("../backups/service.js");
const { SystemService } = await import("../system/service.js");

afterEach(() => vi.restoreAllMocks());

const ZONE_ERROR = () =>
  new DomainError(
    "The change was saved, but the DNS zone file for example.com could not be written (EACCES), so it is not being served yet.",
    "DNS_ZONE_WRITE_FAILED",
    500,
  );

function baseApp() {
  const app = Fastify();
  app.decorate("prisma", {} as PrismaClient);
  const pass = async (request: { userId?: string | null }) => {
    request.userId = "u1";
  };
  app.decorate("requireAuth", pass as unknown as FastifyInstance["requireAuth"]);
  app.decorate("requireRole", (() => pass) as unknown as FastifyInstance["requireRole"]);
  app.decorate(
    "requireRoleOrPermission",
    (() => pass) as unknown as FastifyInstance["requireRoleOrPermission"],
  );
  app.decorate("registerQueue", vi.fn() as unknown as FastifyInstance["registerQueue"]);
  return app;
}

describe("a failed zone write reaches the client as DNS_ZONE_WRITE_FAILED (#50)", () => {
  it("through the mail sync route instead of a masked INTERNAL_ERROR", async () => {
    vi.spyOn(MailService.prototype, "syncVirtualDomains").mockRejectedValue(ZONE_ERROR());
    const app = baseApp();
    await app.register(mailRoutes, { prefix: "/api/mail" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/mail/sync" });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        code: "DNS_ZONE_WRITE_FAILED",
        error: expect.stringContaining("saved"),
      });
    } finally {
      await app.close();
    }
  });

  it("through the backup restore route", async () => {
    vi.spyOn(BackupService.prototype, "restoreItem").mockRejectedValue(ZONE_ERROR());
    vi.spyOn(BackupService.prototype, "getSettings").mockResolvedValue({
      scheduleCron: "0 3 * * *",
    } as never);
    vi.spyOn(SystemService.prototype, "getSettings").mockResolvedValue({
      timezone: "UTC",
    } as never);
    const app = baseApp();
    await app.register(backupRoutes, { prefix: "/api/backups" });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/snap-1/restore",
        payload: { itemType: "dns", itemId: "d1" },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: "DNS_ZONE_WRITE_FAILED" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/domains/:id/dns/sync (#50)", () => {
  function domainApp() {
    const app = baseApp();
    (app.prisma as unknown as { domain: unknown }).domain = {
      findFirst: vi.fn().mockResolvedValue({ id: "d1", dnsMode: "MANAGED" }),
    };
    return app;
  }

  it("re-syncs the caller's own managed zone", async () => {
    const resync = vi.spyOn(DnsService.prototype, "resyncZone").mockResolvedValue({ synced: true });
    const app = domainApp();
    await app.register(domainRoutes, { prefix: "/api/domains" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/domains/d1/dns/sync" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ synced: true });
      expect(resync).toHaveBeenCalledWith("u1", "d1");
    } finally {
      await app.close();
    }
  });

  it("reports the write failure when the zone still cannot be written", async () => {
    vi.spyOn(DnsService.prototype, "resyncZone").mockRejectedValue(ZONE_ERROR());
    const app = domainApp();
    await app.register(domainRoutes, { prefix: "/api/domains" });
    try {
      const res = await app.inject({ method: "POST", url: "/api/domains/d1/dns/sync" });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: "DNS_ZONE_WRITE_FAILED" });
    } finally {
      await app.close();
    }
  });
});
