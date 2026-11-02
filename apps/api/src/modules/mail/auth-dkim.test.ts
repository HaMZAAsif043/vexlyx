import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Public DNS knows nothing: the records below are what must be published.
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    async resolveTxt() {
      throw new Error("ENOTFOUND");
    }
    async resolve4() {
      throw new Error("ENOTFOUND");
    }
    async resolveMx() {
      throw new Error("ENOTFOUND");
    }
  }
  return { default: { Resolver } };
});

const { MailService } = await import("./service.js");

/** A fake postfix_manager.py process that prints `result` and exits 0. */
function managerProcess(result: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: PassThrough;
    stdin: { write: () => void; end: () => void; on: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdin = {
    on: vi.fn(),
    write: () => undefined,
    end: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
        child.emit("close", 0);
      });
    },
  };
  return child;
}

/**
 * Behaves like the real script for the commands the check uses: generate_dkim
 * creates a key for (domain, selector) once and returns the same one forever
 * after; get_dkim only reads.
 */
function fakeKeyStore() {
  const keys = new Map<string, string>();
  const calls: Array<{ command: string; selector: string }> = [];
  let counter = 0;

  spawnMock.mockImplementation((_exe: string, args?: string[]) => {
    const command = args?.[1] ?? "";
    // The payload arrives on stdin; record it through the write hook below.
    const child = managerProcess({});
    let payload: Record<string, string> = {};
    child.stdin.write = ((chunk: string) => {
      payload = JSON.parse(chunk) as Record<string, string>;
    }) as never;
    child.stdin.end = (() => {
      const domain = payload.domain ?? "";
      const selector = payload.selector ?? "";
      calls.push({ command, selector });
      const id = `${domain}/${selector}`;
      let result: unknown;
      if (command === "generate_dkim") {
        const isNew = !keys.has(id);
        if (isNew) keys.set(id, `v=DKIM1; k=rsa; p=KEY${++counter}`);
        result = {
          domain,
          selector,
          dnsRecordName: `${selector}._domainkey.${domain}`,
          dnsRecordValue: keys.get(id),
          publicKey: keys.get(id)?.split("p=")[1],
          keyLength: 2048,
          isNew,
        };
      } else if (command === "get_dkim") {
        result = keys.has(id)
          ? { found: true, domain, selector, dnsRecordValue: keys.get(id) }
          : { found: false, domain, selector };
      } else {
        result = {};
      }
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
        child.emit("close", 0);
      });
    }) as never;
    return child;
  });

  return { keys, calls };
}

type DomainFixture = {
  dnsMode: "CONNECTED" | "MANAGED";
  activeSelector?: string;
};

function serviceFor({ dnsMode, activeSelector }: DomainFixture) {
  const prisma = {
    domain: {
      findFirst: vi.fn().mockImplementation(
        async ({ where }: { where: { userId: string } }) =>
          where.userId === "owner"
            ? {
                id: "d1",
                userId: "owner",
                hostname: "fresh.example",
                dnsMode,
                dnsRecords: [],
              }
            : null,
      ),
    },
    dkimKey: {
      findFirst: vi
        .fn()
        .mockResolvedValue(activeSelector ? { selector: activeSelector } : null),
    },
  };
  const logger = { error: vi.fn(), warn: vi.fn() };
  return {
    service: new MailService(prisma as unknown as PrismaClient, logger),
    logger,
  };
}

const dkimOf = (status: Awaited<ReturnType<InstanceType<typeof MailService>["getMailAuthStatus"]>>) =>
  status.requiredRecords?.find((r) => r.purpose === "DKIM");

beforeEach(() => spawnMock.mockReset());

describe("MailService.getMailAuthStatus: DKIM on a fresh domain (#159)", () => {
  it("lists the DKIM record next to MX, host, SPF and DMARC on the very first check", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED" });

    const status = await service.getMailAuthStatus("owner", "d1");

    expect(status.requiredRecords?.map((r) => r.purpose).sort()).toEqual([
      "DKIM",
      "DMARC",
      "HOST",
      "MX",
      "SPF",
    ]);
    expect(dkimOf(status)).toMatchObject({
      type: "TXT",
      name: "default._domainkey",
      value: "v=DKIM1; k=rsa; p=KEY1",
    });
    expect(store.calls).toEqual([
      { command: "get_dkim", selector: "default" },
      { command: "generate_dkim", selector: "default" },
    ]);
  });

  it("returns the same key on every later check and never creates a second one", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED" });

    const first = dkimOf(await service.getMailAuthStatus("owner", "d1"));
    const second = dkimOf(await service.getMailAuthStatus("owner", "d1"));
    const third = dkimOf(await service.getMailAuthStatus("owner", "d1"));

    expect(second?.value).toBe(first?.value);
    expect(third?.value).toBe(first?.value);
    expect(store.keys.size).toBe(1);
  });

  it("only reads once the key exists, so a polled check never rewrites OpenDKIM's tables or signals it", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED" });

    await service.getMailAuthStatus("owner", "d1");
    store.calls.length = 0;
    await service.getMailAuthStatus("owner", "d1");
    await service.getMailAuthStatus("owner", "d1");

    expect(store.calls.map((c) => c.command)).toEqual(["get_dkim", "get_dkim"]);
  });

  it("agrees with what 'regenerate' publishes", async () => {
    fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED" });

    const checked = dkimOf(await service.getMailAuthStatus("owner", "d1"));
    const generated = await service.getOrGenerateDkim("owner", "d1", false);

    expect(generated.dnsRecordValue).toBe(checked?.value);
  });

  it("does not touch a domain's key once rotation has made another selector active", async () => {
    const store = fakeKeyStore();
    store.keys.set("fresh.example/s2", "v=DKIM1; k=rsa; p=ROTATED");
    const { service } = serviceFor({ dnsMode: "CONNECTED", activeSelector: "s2" });

    const status = await service.getMailAuthStatus("owner", "d1");

    expect(dkimOf(status)).toMatchObject({ name: "s2._domainkey", value: "v=DKIM1; k=rsa; p=ROTATED" });
    expect(store.calls.map((c) => c.command)).toEqual(["get_dkim"]);
  });

  it("leaves a rotated domain whose key file is missing alone instead of inventing a new key", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED", activeSelector: "s2" });

    const status = await service.getMailAuthStatus("owner", "d1");

    expect(dkimOf(status)).toBeUndefined();
    expect(store.keys.size).toBe(0);
  });

  it("still answers, and logs, when the key cannot be created", async () => {
    spawnMock.mockImplementation((_exe: string, args?: string[]) =>
      args?.[1] === "get_dkim"
        ? managerProcess({ found: false })
        : managerProcess({ error: "openssl missing", code: "KEYGEN_FAILED" }),
    );
    const { service, logger } = serviceFor({ dnsMode: "CONNECTED" });

    const status = await service.getMailAuthStatus("owner", "d1");

    expect(dkimOf(status)).toBeUndefined();
    expect(status.requiredRecords?.map((r) => r.purpose)).toContain("MX");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not create keys when checking a domain whose DNS is hosted here", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "MANAGED" });

    await service.getMailAuthStatus("owner", "d1");

    expect(store.calls).toEqual([]);
  });

  it("refuses another user's domain and creates nothing", async () => {
    const store = fakeKeyStore();
    const { service } = serviceFor({ dnsMode: "CONNECTED" });

    await expect(service.getMailAuthStatus("intruder", "d1")).rejects.toMatchObject({
      code: "DOMAIN_NOT_FOUND",
      statusCode: 404,
    });
    expect(store.calls).toEqual([]);
  });
});
