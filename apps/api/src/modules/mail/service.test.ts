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
const { MailService, synchronizeMailState } = await import("./service.js");
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
