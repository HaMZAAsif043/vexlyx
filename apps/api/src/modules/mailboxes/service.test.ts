import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("../../utils/quota.js", () => ({
  assertUnderQuota: vi.fn(async () => undefined),
  notifyQuotaThreshold: vi.fn(async () => undefined),
}));

const { MailboxService } = await import("./service.js");
const { MailService, MailError } = await import("../mail/service.js");

afterEach(() => vi.restoreAllMocks());

const SYNC_OK = {
  success: true,
  syncedCount: 1,
  domains: ["example.com"],
  mailboxesSynced: 1,
};

function syncFails() {
  return vi
    .spyOn(MailService.prototype, "syncVirtualDomains")
    .mockRejectedValue(
      new MailError(
        "Failed to rebuild Postfix map 'virtual_mailbox_maps' (exit 1)",
        "POSTFIX_MAP_COMPILE_FAILED",
        502,
      ),
    );
}

function fixture(existingMailboxesInDomain = 1) {
  const existing = { id: "m1", address: "alice@example.com", userId: "u1", domainId: "d1" };
  const prisma = {
    domain: {
      findFirst: vi.fn().mockResolvedValue({ id: "d1", hostname: "example.com" }),
    },
    mailbox: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(existing),
      count: vi.fn().mockResolvedValue(existingMailboxesInDomain),
      update: vi.fn().mockResolvedValue(existing),
      delete: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: "m1",
        ...data,
        status: "ACTIVE",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        domain: { hostname: "example.com" },
      })),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new MailboxService(
    prisma as unknown as PrismaClient,
    auditLog as unknown as AuditLogService,
  );
  return { prisma, auditLog, service };
}

const INPUT = { domainId: "d1", localPart: "alice", quota: 1024 as const };

describe("MailboxService.create (#51)", () => {
  it("returns the mailbox and password with no warnings when the mail server sync succeeds", async () => {
    vi.spyOn(MailService.prototype, "syncVirtualDomains").mockResolvedValue(SYNC_OK);
    const { auditLog, service } = fixture();

    const result = await service.create("u1", INPUT);

    expect(result.mailbox.address).toBe("alice@example.com");
    expect(result.password).toEqual(expect.any(String));
    expect(result).not.toHaveProperty("warnings");
    expect(auditLog.log).toHaveBeenCalledWith(
      "u1",
      "mailbox.created",
      { type: "Mailbox", id: "m1" },
      expect.anything(),
    );
  });

  it("still returns the one-time password, with a warning, when the map rebuild fails", async () => {
    syncFails();
    const { service } = fixture();

    const result = await service.create("u1", INPUT);

    // The password is shown once and only its hash is stored: throwing here would lose it.
    expect(result.password).toEqual(expect.any(String));
    expect(result.password.length).toBeGreaterThan(8);
    expect(result.mailbox.address).toBe("alice@example.com");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("virtual_mailbox_maps");
    expect(result.warnings![0]).toContain("Sync");
  });

  it("audits the creation even when the mail server sync fails", async () => {
    syncFails();
    const { auditLog, service } = fixture();

    await service.create("u1", INPUT);

    expect(auditLog.log).toHaveBeenCalledWith(
      "u1",
      "mailbox.created",
      { type: "Mailbox", id: "m1" },
      expect.anything(),
    );
  });

  it("still sets up SPF/DKIM/DMARC/MX for the domain's first mailbox when the sync fails", async () => {
    syncFails();
    const ensure = vi
      .spyOn(MailService.prototype, "ensureEmailAuthRecords")
      .mockResolvedValue(undefined as never);
    const { service } = fixture(0);

    await service.create("u1", INPUT);

    expect(ensure).toHaveBeenCalledWith("u1", "d1");
  });
});

describe("other mailbox changes report a failed sync as a warning (#51)", () => {
  it("resetPassword returns the new password with the warning", async () => {
    syncFails();
    const { prisma, service } = fixture();

    const result = await service.resetPassword("u1", "m1");

    expect(prisma.mailbox.update).toHaveBeenCalledTimes(1);
    expect(result.password).toEqual(expect.any(String));
    expect(result.warnings).toHaveLength(1);
  });

  it("updateQuota returns the warning instead of failing a saved change", async () => {
    syncFails();
    const { prisma, service } = fixture();

    const result = await service.updateQuota("u1", "m1", { quota: 512 } as never);

    expect(prisma.mailbox.update).toHaveBeenCalledTimes(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("delete is audited even when the sync fails, and returns the warning", async () => {
    syncFails();
    const { prisma, auditLog, service } = fixture();

    const result = await service.delete("u1", "m1");

    expect(prisma.mailbox.delete).toHaveBeenCalledTimes(1);
    expect(auditLog.log).toHaveBeenCalledWith(
      "u1",
      "mailbox.deleted",
      { type: "Mailbox", id: "m1" },
      expect.anything(),
    );
    expect(result.warnings).toHaveLength(1);
  });

  it("returns no warnings when the sync succeeds", async () => {
    vi.spyOn(MailService.prototype, "syncVirtualDomains").mockResolvedValue(SYNC_OK);
    const { service } = fixture();

    await expect(service.updateQuota("u1", "m1", { quota: 512 } as never)).resolves.toEqual({
      warnings: [],
    });
    await expect(service.delete("u1", "m1")).resolves.toEqual({ warnings: [] });
  });

  it("still rejects an unknown mailbox before touching the mail server", async () => {
    const sync = vi.spyOn(MailService.prototype, "syncVirtualDomains");
    const { prisma, service } = fixture();
    prisma.mailbox.findFirst.mockResolvedValue(null);

    await expect(service.delete("u1", "nope")).rejects.toMatchObject({ code: "MAILBOX_NOT_FOUND" });
    expect(sync).not.toHaveBeenCalled();
  });
});
