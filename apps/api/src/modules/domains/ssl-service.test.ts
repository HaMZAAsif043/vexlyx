import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { SslService } = await import("./ssl-service.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function cert(id: string, domainId: string, hostname: string, daysFromNow: number, status = "ACTIVE") {
  return {
    id,
    domainId,
    status,
    validTo: new Date(Date.now() + daysFromNow * DAY_MS),
    domain: { id: domainId, hostname },
  };
}

function fixture(certificates: ReturnType<typeof cert>[]) {
  const prisma = {
    certificate: {
      findMany: vi.fn().mockResolvedValue(certificates),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
  const service = new SslService(prisma as unknown as PrismaClient);
  return { prisma, service };
}

describe("SslService.checkExpiryAlerts (#43)", () => {
  it("queries only certificates of domains owned by the caller", async () => {
    const { prisma, service } = fixture([]);

    await service.checkExpiryAlerts("u1");

    expect(prisma.certificate.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.certificate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { domain: { userId: "u1" } } }),
    );
  });

  it("returns an empty result when the caller has no certificates", async () => {
    const { service } = fixture([]);

    await expect(service.checkExpiryAlerts("u1")).resolves.toEqual({
      totalChecked: 0,
      expiringSoon: 0,
      expired: 0,
      alerts: [],
    });
  });

  it("alerts on expiring and expired certificates and ignores healthy ones", async () => {
    const { service } = fixture([
      cert("c1", "d1", "soon.example.com", 3),
      cert("c2", "d2", "gone.example.com", -2),
      cert("c3", "d3", "fine.example.com", 60),
    ]);

    const result = await service.checkExpiryAlerts("u1");

    expect(result.totalChecked).toBe(3);
    expect(result.expiringSoon).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.alerts.map((a) => [a.hostname, a.status])).toEqual([
      ["soon.example.com", "EXPIRING_SOON"],
      ["gone.example.com", "EXPIRED"],
    ]);
  });

  it("only refreshes status on certificates whose status actually changed", async () => {
    const { prisma, service } = fixture([
      cert("c1", "d1", "soon.example.com", 3, "ACTIVE"),
      cert("c3", "d3", "fine.example.com", 60, "ACTIVE"),
    ]);

    await service.checkExpiryAlerts("u1");

    expect(prisma.certificate.update).toHaveBeenCalledTimes(1);
    expect(prisma.certificate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ status: "EXPIRING_SOON" }) }),
    );
  });
});
