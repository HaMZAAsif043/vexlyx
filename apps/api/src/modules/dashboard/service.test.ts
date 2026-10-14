import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { ServerMetrics } from "@vexlyx/shared";

const { mockGetServerMetrics, mockCheckExpiryAlerts } = vi.hoisted(() => ({
  mockGetServerMetrics: vi.fn(),
  mockCheckExpiryAlerts: vi.fn(),
}));

vi.mock("../monitoring/service.js", () => ({
  MonitoringService: vi.fn().mockImplementation(function MonitoringServiceMock(this: {
    getServerMetrics: typeof mockGetServerMetrics;
  }) {
    this.getServerMetrics = mockGetServerMetrics;
  }),
}));

vi.mock("../domains/ssl-service.js", () => ({
  SslService: vi.fn().mockImplementation(function SslServiceMock(this: {
    checkExpiryAlerts: typeof mockCheckExpiryAlerts;
  }) {
    this.checkExpiryAlerts = mockCheckExpiryAlerts;
  }),
}));

const { DashboardService } = await import("./service.js");

const USER_ID = "user-1";

const SAMPLE_SERVER_METRICS: ServerMetrics = {
  cpuPercent: 12.5,
  cpuCoreCount: 4,
  cpuPerCore: [10, 15, 12, 13],
  ramUsed: 2_000_000_000,
  ramTotal: 8_000_000_000,
  ramPercent: 25,
  diskUsed: 10_000_000_000,
  diskTotal: 50_000_000_000,
  diskPercent: 20,
  uptimeSeconds: 3600,
  loadAvg1: 0.1,
  loadAvg5: 0.2,
  loadAvg15: 0.15,
  netRxBytes: 1000,
  netTxBytes: 2000,
};

interface PrismaMock {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  project: { count: ReturnType<typeof vi.fn> };
  domain: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  database: { count: ReturnType<typeof vi.fn> };
  mailbox: { count: ReturnType<typeof vi.fn> };
  deployment: { findMany: ReturnType<typeof vi.fn> };
  backupSnapshot: { findMany: ReturnType<typeof vi.fn> };
}

function createPrismaMock(overrides: { role?: "ADMIN" | "USER" | "RESELLER" } = {}): PrismaMock {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        role: overrides.role ?? "USER",
        maxProjects: null,
        maxDomains: null,
        maxDatabases: null,
        maxMailboxes: null,
        maxSubAccounts: null,
      }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    project: { count: vi.fn().mockResolvedValue(3) },
    domain: { count: vi.fn().mockResolvedValue(2), findMany: vi.fn().mockResolvedValue([{ id: "domain-1" }]) },
    database: { count: vi.fn().mockResolvedValue(1) },
    mailbox: { count: vi.fn().mockResolvedValue(4) },
    deployment: { findMany: vi.fn().mockResolvedValue([]) },
    backupSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

const noopLogger = {} as FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerMetrics.mockReset().mockResolvedValue(SAMPLE_SERVER_METRICS);
  mockCheckExpiryAlerts.mockReset().mockResolvedValue({ totalChecked: 0, expiringSoon: 0, expired: 0, alerts: [] });
});

describe("DashboardService.getSummary", () => {
  it("returns stat counts matching getUsageSummary", async () => {
    const prisma = createPrismaMock();
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(summary.stats).toEqual({
      projects: { used: 3, limit: null },
      domains: { used: 2, limit: null },
      databases: { used: 1, limit: null },
      mailboxes: { used: 4, limit: null },
    });
  });

  it.each(["USER", "RESELLER"] as const)(
    "withholds host-wide serverMetrics from a %s without collecting them",
    async (role) => {
      const prisma = createPrismaMock({ role });
      const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

      const summary = await service.getSummary(USER_ID);

      expect(summary.serverMetrics).toBeNull();
      expect(mockGetServerMetrics).not.toHaveBeenCalled();
    },
  );

  it("returns serverMetrics to an admin", async () => {
    const prisma = createPrismaMock({ role: "ADMIN" });
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(summary.serverMetrics).toEqual(SAMPLE_SERVER_METRICS);
  });

  it("excludes backup activity for a non-admin user", async () => {
    const prisma = createPrismaMock({ role: "USER" });
    prisma.backupSnapshot.findMany.mockResolvedValue([
      { id: "b1", status: "COMPLETED", trigger: "MANUAL", createdAt: new Date() },
    ]);
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(summary.activity.some((item) => item.type === "backup")).toBe(false);
    expect(prisma.backupSnapshot.findMany).not.toHaveBeenCalled();
  });

  it("includes backup activity for an admin user", async () => {
    const prisma = createPrismaMock({ role: "ADMIN" });
    prisma.backupSnapshot.findMany.mockResolvedValue([
      { id: "b1", status: "COMPLETED", trigger: "MANUAL", createdAt: new Date() },
    ]);
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(summary.activity.some((item) => item.type === "backup" && item.id === "b1")).toBe(true);
  });

  it("degrades to null serverMetrics when monitoring fails", async () => {
    mockGetServerMetrics.mockReset().mockRejectedValue(new Error("monitor unavailable"));
    const prisma = createPrismaMock({ role: "ADMIN" });
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(summary.serverMetrics).toBeNull();
    expect(summary.stats).toEqual({
      projects: { used: 3, limit: null },
      domains: { used: 2, limit: null },
      databases: { used: 1, limit: null },
      mailboxes: { used: 4, limit: null },
    });
  });

  it("asks the SSL service for the caller's alerts only and maps them to feed items", async () => {
    const prisma = createPrismaMock();
    mockCheckExpiryAlerts.mockResolvedValue({
      totalChecked: 1,
      expiringSoon: 1,
      expired: 0,
      alerts: [
        { domainId: "domain-1", hostname: "mine.example.com", daysRemaining: 3, status: "EXPIRING_SOON" },
      ],
    });
    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);

    const summary = await service.getSummary(USER_ID);

    expect(mockCheckExpiryAlerts).toHaveBeenCalledWith(USER_ID);
    const sslAlerts = summary.activity.filter((item) => item.type === "ssl_alert");
    expect(sslAlerts).toHaveLength(1);
    expect(sslAlerts[0]?.title).toContain("mine.example.com");
    expect(summary.sslExpiringCount).toBe(1);
  });

  it("caps the merged feed at 15 items and sorts newest first", async () => {
    const prisma = createPrismaMock({ role: "ADMIN" });
    const now = Date.now();

    prisma.deployment.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `deploy-${i}`,
        status: "RUNNING",
        commitHash: "abc123",
        commitMsg: null,
        createdAt: new Date(now - i * 1000),
        project: { id: "proj-1", name: "Project One" },
      })),
    );
    prisma.backupSnapshot.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `backup-${i}`,
        status: "COMPLETED",
        trigger: "SCHEDULED",
        createdAt: new Date(now - 20_000 - i * 1000),
      })),
    );
    prisma.domain.findMany.mockResolvedValue([{ id: "domain-1" }]);
    mockCheckExpiryAlerts.mockResolvedValue({
      totalChecked: 1,
      expiringSoon: 1,
      expired: 0,
      alerts: [{ domainId: "domain-1", hostname: "old.example.com", daysRemaining: 5, status: "EXPIRING_SOON" }],
    });

    const service = new DashboardService(prisma as unknown as PrismaClient, noopLogger);
    const summary = await service.getSummary(USER_ID);

    expect(summary.activity.length).toBeLessThanOrEqual(15);
    const timestamps = summary.activity.map((item) => new Date(item.timestamp).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
    // sslExpiringCount is counted independently of the merged/capped feed.
    expect(summary.sslExpiringCount).toBe(1);
  });
});
