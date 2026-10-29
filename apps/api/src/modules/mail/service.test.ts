import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileMailState, MailStateSyncError } from "./state-sync.js";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
vi.mock("./state-sync.js", async (original) => ({
  ...(await original<typeof import("./state-sync.js")>()),
  reconcileMailState: vi.fn(),
}));
const { MailService, senderBelongsToDomains, synchronizeMailState } = await import("./service.js");
const { MailboxService } = await import("../mailboxes/service.js");
const domains = [
  {
    hostname: "one.example",
    userId: "u1",
    mailboxes: [
      { address: "admin@one.example", password: "hash-one", quota: 100 },
    ],
  },
  {
    hostname: "two.example",
    userId: "u2",
    mailboxes: [
      { address: "keep@two.example", password: "hash-two", quota: 200 },
    ],
  },
];
const aliases = [
  {
    source: "help@one.example",
    destinations: ["admin@one.example"],
    userId: "u1",
  },
  {
    source: "help@two.example",
    destinations: ["keep@two.example"],
    userId: "u2",
  },
];
function fixture() {
  const database = {
    domain: { findMany: vi.fn(() => Promise.resolve(domains)) },
    virtualAlias: { findMany: vi.fn(() => Promise.resolve(aliases)) },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };
  return { database, prisma: database as unknown as PrismaClient };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconcileMailState).mockImplementation(
    async (_python, _script, snapshot) => {
      await snapshot();
    },
  );
});
describe("authoritative shared mail snapshot", () => {
  it("audits a saved deletion even when live mail activation fails", async () => {
    const events: string[] = [];
    const prisma = {
      mailbox: {
        findFirst: vi.fn(async () => ({
          id: "m1",
          address: "admin@one.example",
        })),
        delete: vi.fn(async () => {
          events.push("database");
        }),
      },
    } as unknown as PrismaClient;
    const audit = {
      log: vi.fn(async () => {
        events.push("audit");
      }),
    } as unknown as AuditLogService;
    const sync = vi
      .spyOn(MailService.prototype, "syncVirtualDomains")
      .mockImplementation(async () => {
        events.push("activation");
        throw new MailStateSyncError(
          "Postfix failed",
          "MAIL_STATE_ACTIVATION_FAILED",
        );
      });
    try {
      await expect(
        new MailboxService(prisma, audit).delete("u1", "m1"),
      ).resolves.toEqual({
        warnings: [expect.stringContaining("Postfix failed")],
      });
      expect(events).toEqual(["database", "audit", "activation"]);
      expect(audit.log).toHaveBeenCalledWith(
        "u1",
        "mailbox.deleted",
        { type: "Mailbox", id: "m1" },
        { before: { address: "admin@one.example" } },
      );
    } finally {
      sync.mockRestore();
    }
  });
  it("includes all tenants in one repeatable-read snapshot after acquiring the lock", async () => {
    const { prisma, database } = fixture();
    let payload: unknown;
    vi.mocked(reconcileMailState).mockImplementation(
      async (_python, _script, snapshot) => {
        expect(database.domain.findMany).not.toHaveBeenCalled();
        payload = await snapshot();
      },
    );
    await synchronizeMailState(prisma);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: "RepeatableRead",
    });
    expect(database.domain.findMany.mock.calls[0]).toEqual([
      expect.not.objectContaining({ where: expect.anything() }),
    ]);
    expect(payload).toEqual({
      domains: ["one.example", "two.example"],
      mailboxes: [
        {
          address: "admin@one.example",
          passwordHash: "hash-one",
          quotaMb: 100,
        },
        { address: "keep@two.example", passwordHash: "hash-two", quotaMb: 200 },
      ],
      aliases: aliases.map(({ source, destinations }) => ({
        source,
        destinations,
      })),
    });
  });
  it("limits the caller response to their domains and mailbox count", async () => {
    const { prisma } = fixture();
    expect(await new MailService(prisma).syncVirtualDomains("u1")).toEqual({
      success: true,
      syncedCount: 1,
      domains: ["one.example"],
      mailboxesSynced: 1,
    });
  });
  it("limits the caller alias count without omitting other tenants from reconciliation", async () => {
    const { prisma } = fixture();
    expect(await new MailService(prisma).syncVirtualAliases("u1")).toEqual({
      success: true,
      syncedCount: 1,
    });
  });
  it("returns a retryable 503 with rollback diagnostics on activation failure", async () => {
    const { prisma } = fixture();
    vi.mocked(reconcileMailState).mockRejectedValue(
      new MailStateSyncError("Postfix failed", "MAIL_STATE_ACTIVATION_FAILED", {
        rollbackFailed: ["postfix"],
      }),
    );
    await expect(synchronizeMailState(prisma)).rejects.toMatchObject({
      statusCode: 503,
      code: "MAIL_STATE_ACTIVATION_FAILED",
      details: { rollbackFailed: ["postfix"] },
    });
  });
});

describe("test email sender ownership (#194)", () => {
  it("accepts an address on an owned domain or its subdomains", () => {
    expect(senderBelongsToDomains("one.example", ["one.example"])).toBe(true);
    expect(senderBelongsToDomains("mail.one.example", ["one.example"])).toBe(true);
    expect(senderBelongsToDomains("one.example", ["*.one.example"])).toBe(true);
    expect(senderBelongsToDomains("deep.mail.one.example", ["one.example"])).toBe(true);
  });

  it("rejects look-alike and unrelated domains", () => {
    expect(senderBelongsToDomains("notone.example", ["one.example"])).toBe(false);
    expect(senderBelongsToDomains("one.example.evil.test", ["one.example"])).toBe(false);
    expect(senderBelongsToDomains("two.example", ["one.example"])).toBe(false);
    expect(senderBelongsToDomains("example.com", [])).toBe(false);
  });

  it("refuses to send when the sender is not on a domain the caller owns", async () => {
    const prisma = {
      domain: {
        findMany: vi.fn(async () => [{ hostname: "one.example" }]),
      },
    } as unknown as PrismaClient;
    await expect(
      new MailService(prisma).sendTestEmail("u1", {
        from: "ceo@bank.example",
        to: "victim@example.net",
        subject: "Test",
        body: "Test",
        port: 587,
        useTls: true,
      }),
    ).rejects.toMatchObject({ code: "SENDER_NOT_OWNED", statusCode: 403 });
    expect(prisma.domain.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { hostname: true },
    });
  });
});
