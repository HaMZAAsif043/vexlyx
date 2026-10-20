import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { assertNominalPoolWithinCap, assertUnderQuota, getUsageSummary } from "./quota.js";

function makeError(message: string, code: string, statusCode: number) {
  const err = new Error(message) as Error & { code: string; statusCode: number };
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

interface PrismaMock {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  project: { count: ReturnType<typeof vi.fn> };
  domain: { count: ReturnType<typeof vi.fn> };
  database: { count: ReturnType<typeof vi.fn> };
  mailbox: { count: ReturnType<typeof vi.fn> };
  scheduledTask: { count: ReturnType<typeof vi.fn> };
}

function createPrismaMock(): PrismaMock {
  return {
    user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    project: { count: vi.fn() },
    domain: { count: vi.fn() },
    database: { count: vi.fn() },
    mailbox: { count: vi.fn() },
    scheduledTask: { count: vi.fn(async () => 0) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertNominalPoolWithinCap", () => {
  it("blocks a sub-account quota update that would push the nominal sum over the reseller's limit", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      oversellingEnabled: false,
      maxProjects: 10,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
    });
    // One sibling sub-account already has maxProjects: 5.
    prisma.user.findMany.mockResolvedValue([
      { maxProjects: 5, maxDomains: null, maxDatabases: null, maxMailboxes: null },
    ]);

    await expect(
      assertNominalPoolWithinCap(
        prisma as unknown as PrismaClient,
        "reseller-1",
        "sub-2",
        { project: 6, domain: null, database: null, mailbox: null, scheduledTask: null },
        makeError,
      ),
    ).rejects.toMatchObject({ code: "OVERSELL_NOT_ENABLED" });
  });

  it("allows the same nominal sum once overselling is enabled", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      oversellingEnabled: true,
      maxProjects: 10,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { maxProjects: 5, maxDomains: null, maxDatabases: null, maxMailboxes: null },
    ]);

    await expect(
      assertNominalPoolWithinCap(
        prisma as unknown as PrismaClient,
        "reseller-1",
        "sub-2",
        { project: 6, domain: null, database: null, mailbox: null, scheduledTask: null },
        makeError,
      ),
    ).resolves.toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("blocks setting a sub-account quota to unlimited while the reseller enforces a finite cap", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      oversellingEnabled: false,
      maxProjects: 10,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
    });
    prisma.user.findMany.mockResolvedValue([]);

    await expect(
      assertNominalPoolWithinCap(
        prisma as unknown as PrismaClient,
        "reseller-1",
        "sub-2",
        { project: null, domain: null, database: null, mailbox: null, scheduledTask: null },
        makeError,
      ),
    ).rejects.toMatchObject({ code: "OVERSELL_NOT_ENABLED" });
  });

  it("allows a nominal sum within the reseller's limit", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      oversellingEnabled: false,
      maxProjects: 10,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
      maxScheduledTasks: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { maxProjects: 3, maxDomains: null, maxDatabases: null, maxMailboxes: null, maxScheduledTasks: null },
    ]);

    await expect(
      assertNominalPoolWithinCap(
        prisma as unknown as PrismaClient,
        "reseller-1",
        "sub-2",
        { project: 5, domain: null, database: null, mailbox: null, scheduledTask: null },
        makeError,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("assertUnderQuota — F5.20 aggregate pool check", () => {
  it("blocks resource creation once real aggregate usage across the pool hits the reseller's limit, even though nominal sum is higher", async () => {
    const prisma = createPrismaMock();
    // The creating user (a sub-account) is under their own quota.
    prisma.user.findUnique
      .mockResolvedValueOnce({ role: "USER", resellerId: "reseller-1", maxProjects: 5 })
      // Reseller lookup: overselling enabled, limit 10.
      .mockResolvedValueOnce({ oversellingEnabled: true, maxProjects: 10 });
    prisma.user.findMany.mockResolvedValue([{ id: "reseller-1" }, { id: "sub-2" }, { id: "sub-3" }]);
    prisma.project.count
      .mockResolvedValueOnce(2) // own count, under own limit of 5
      .mockResolvedValueOnce(4) // reseller's own usage
      .mockResolvedValueOnce(4) // sub-2
      .mockResolvedValueOnce(2); // sub-3 -> total pool usage 10

    await expect(
      assertUnderQuota(prisma as unknown as PrismaClient, "sub-2", "project", makeError),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("does not run the aggregate check when the reseller has overselling disabled", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique
      .mockResolvedValueOnce({ role: "USER", resellerId: "reseller-1", maxProjects: 5 })
      .mockResolvedValueOnce({ oversellingEnabled: false, maxProjects: 10 });
    prisma.project.count.mockResolvedValueOnce(2);

    await expect(
      assertUnderQuota(prisma as unknown as PrismaClient, "sub-2", "project", makeError),
    ).resolves.toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("leaves plain per-user quota behavior unchanged for a user with no reseller", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValueOnce({ role: "USER", resellerId: null, maxProjects: 5 });
    prisma.project.count.mockResolvedValueOnce(5);

    await expect(
      assertUnderQuota(prisma as unknown as PrismaClient, "user-1", "project", makeError),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("assertUnderQuota — scheduled tasks of deleted projects", () => {
  it("does not count a task whose project was soft-deleted (it is unreachable and would block the quota forever)", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValueOnce({ role: "USER", resellerId: null, maxScheduledTasks: 1 });
    prisma.scheduledTask.count.mockResolvedValueOnce(0);

    await expect(
      assertUnderQuota(prisma as unknown as PrismaClient, "user-1", "scheduledTask", makeError),
    ).resolves.toBeUndefined();

    expect(prisma.scheduledTask.count).toHaveBeenCalledWith({
      where: { userId: "user-1", project: { deletedAt: null } },
    });
  });
});

describe("getUsageSummary — F5.20 oversold reporting", () => {
  it("reports oversold: true when a reseller's sub-accounts nominally exceed their limit", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      role: "RESELLER",
      maxProjects: 10,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
      maxSubAccounts: null,
      maxScheduledTasks: null,
    });
    prisma.user.findMany.mockResolvedValue([
      { maxProjects: 8, maxDomains: null, maxDatabases: null, maxMailboxes: null, maxScheduledTasks: null },
      { maxProjects: 8, maxDomains: null, maxDatabases: null, maxMailboxes: null, maxScheduledTasks: null },
    ]);
    prisma.project.count.mockResolvedValue(3);
    prisma.domain.count.mockResolvedValue(0);
    prisma.database.count.mockResolvedValue(0);
    prisma.mailbox.count.mockResolvedValue(0);

    const summary = await getUsageSummary(prisma as unknown as PrismaClient, "reseller-1");

    expect(summary.project.nominalSum).toBe(16);
    expect(summary.project.oversold).toBe(true);
  });

  it("does not report oversold fields for a non-reseller user", async () => {
    const prisma = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({
      role: "USER",
      maxProjects: 5,
      maxDomains: null,
      maxDatabases: null,
      maxMailboxes: null,
      maxSubAccounts: null,
      maxScheduledTasks: null,
    });
    prisma.project.count.mockResolvedValue(1);
    prisma.domain.count.mockResolvedValue(0);
    prisma.database.count.mockResolvedValue(0);
    prisma.mailbox.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);

    const summary = await getUsageSummary(prisma as unknown as PrismaClient, "user-1");

    expect(summary.project.oversold).toBeUndefined();
    expect(summary.project.nominalSum).toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
