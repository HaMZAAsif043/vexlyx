import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { MailService, MailError } = await import("./service.js");

/** Fake manager script: prints `stdout` and exits with `code`. */
function script(stdout: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: () => void; end: () => void };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => undefined,
    end: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
    },
  };
  return child;
}

const MAP_ERROR = {
  error:
    "Failed to rebuild Postfix map 'virtual_mailbox_maps' (exit 1: postmap: fatal: open database). Postfix is still using the previous map.",
  code: "POSTFIX_MAP_COMPILE_FAILED",
};

function respondWith(handlers: Record<string, { stdout: unknown; code: number }>) {
  spawnMock.mockImplementation((_exe: string, args?: string[]) => {
    const command = Array.isArray(args) ? (args[1] ?? "") : "";
    const handler = handlers[command] ?? { stdout: { success: true, syncedCount: 0 }, code: 0 };
    return script(JSON.stringify(handler.stdout), handler.code);
  });
}

function service() {
  const prisma = {
    domain: {
      findMany: vi.fn().mockResolvedValue([
        { hostname: "example.com", mailboxes: [{ address: "a@example.com", password: "h", quota: 100 }] },
      ]),
    },
    virtualAlias: {
      findMany: vi.fn().mockResolvedValue([{ source: "info@example.com", destinations: ["a@example.com"] }]),
    },
  };
  return new MailService(prisma as unknown as PrismaClient);
}

beforeEach(() => spawnMock.mockReset());

describe("MailService.syncVirtualDomains (#51)", () => {
  it("returns the sync result when the map rebuild succeeds", async () => {
    respondWith({
      sync_virtual_domains: {
        stdout: { success: true, syncedCount: 1, domains: ["example.com"], reloaded: true },
        code: 0,
      },
      sync_mailboxes: { stdout: { success: true, syncedCount: 1 }, code: 0 },
    });

    await expect(service().syncVirtualDomains("u1")).resolves.toMatchObject({
      success: true,
      syncedCount: 1,
      mailboxesSynced: 1,
    });
  });

  it("rejects with the script's code when the postmap rebuild failed", async () => {
    respondWith({ sync_virtual_domains: { stdout: MAP_ERROR, code: 1 } });

    const err = await service().syncVirtualDomains("u1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ code: "POSTFIX_MAP_COMPILE_FAILED", statusCode: 502 });
    expect((err as Error).message).toContain("virtual_mailbox_maps");
  });
});

describe("MailService.syncVirtualAliases (#51)", () => {
  it("returns the sync result when the map rebuild succeeds", async () => {
    respondWith({ sync_virtual_aliases: { stdout: { success: true, syncedCount: 1 }, code: 0 } });

    await expect(service().syncVirtualAliases("u1")).resolves.toMatchObject({
      success: true,
      syncedCount: 1,
    });
  });

  it("rejects when the alias map rebuild failed", async () => {
    respondWith({
      sync_virtual_aliases: {
        stdout: { ...MAP_ERROR, error: MAP_ERROR.error.replace("virtual_mailbox_maps", "virtual_alias_maps") },
        code: 1,
      },
    });

    await expect(service().syncVirtualAliases("u1")).rejects.toMatchObject({
      code: "POSTFIX_MAP_COMPILE_FAILED",
    });
  });
});
