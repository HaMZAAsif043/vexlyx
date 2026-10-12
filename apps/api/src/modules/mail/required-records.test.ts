import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const answers = vi.hoisted(() => ({
  txt: {} as Record<string, string[][]>,
  mx: {} as Record<string, Array<{ exchange: string; priority: number }>>,
  a: {} as Record<string, string[]>,
}));

vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    async resolveTxt(name: string) {
      const found = answers.txt[name];
      if (!found) throw new Error("ENOTFOUND");
      return found;
    }
    async resolve4(name: string) {
      const found = answers.a[name];
      if (!found) throw new Error("ENOTFOUND");
      return found;
    }
    async resolveMx(name: string) {
      const found = answers.mx[name];
      if (!found) throw new Error("ENOTFOUND");
      return found;
    }
  }
  return { default: { Resolver } };
});

// config/env.ts validates process.env at import time (dns-service imports it)
process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";

const {
  buildMailRoutingRecords,
  buildRequiredMailRecords,
  isRecordLive,
  lookupLiveMailRecords,
} = await import("./required-records.js");
const { DnsService } = await import("../domains/dns-service.js");

const DKIM_VALUE = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A";
const required = buildRequiredMailRecords("example.com", "203.0.113.5", {
  selector: "default",
  value: DKIM_VALUE,
});

describe("buildRequiredMailRecords", () => {
  it("returns MX, SPF, DMARC and DKIM records for the domain", () => {
    expect(required.map((r) => r.purpose)).toEqual([
      "MX",
      "HOST",
      "SPF",
      "DMARC",
      "DKIM",
    ]);
    expect(required.find((r) => r.purpose === "HOST")).toMatchObject({
      type: "A",
      name: "mail",
      value: "203.0.113.5",
    });
    expect(required.find((r) => r.purpose === "SPF")?.value).toBe(
      "v=spf1 mx a ip4:203.0.113.5 ~all",
    );
    expect(required.find((r) => r.purpose === "MX")).toMatchObject({
      value: "mail.example.com",
      priority: 10,
    });
    expect(required.find((r) => r.purpose === "DKIM")?.name).toBe(
      "default._domainkey",
    );
  });

  it("omits DKIM when no key exists yet", () => {
    expect(
      buildRequiredMailRecords("example.com", "203.0.113.5").map(
        (r) => r.purpose,
      ),
    ).not.toContain("DKIM");
  });

  it("builds routing records for a custom mail hostname and domain", () => {
    expect(
      buildMailRoutingRecords("example.org", "mx1.mailhost.net", "203.0.113.8"),
    ).toEqual([
      {
        purpose: "MX",
        type: "MX",
        name: "@",
        value: "mx1.mailhost.net",
        priority: 10,
      },
      {
        purpose: "HOST",
        type: "A",
        name: "mx1.mailhost.net",
        value: "203.0.113.8",
      },
    ]);
  });
});

describe("lookupLiveMailRecords", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VEXLYX_MOCK_DNS", "false");
    answers.txt = {};
    answers.mx = {};
    answers.a = {};
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports every record live when public DNS serves them", async () => {
    answers.txt = {
      "example.com": [["v=spf1 include:_spf.google.com ~all"]],
      "_dmarc.example.com": [["v=DMARC1; p=none"]],
      "default._domainkey.example.com": [
        ["v=DKIM1; k=rsa; ", "p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"],
      ],
    };
    answers.mx = {
      "example.com": [{ exchange: "mail.example.com", priority: 10 }],
    };
    answers.a = { "mail.example.com": ["203.0.113.5"] };

    const live = await lookupLiveMailRecords("example.com", required);

    expect(required.every((r) => isRecordLive(r, live))).toBe(true);
  });

  it("reports nothing live when the registrar has no records", async () => {
    const live = await lookupLiveMailRecords("example.com", required);

    expect(live).toEqual([]);
    expect(required.some((r) => isRecordLive(r, live))).toBe(false);
  });

  it("does not count a mail host A record pointing at another server", async () => {
    answers.a = { "mail.example.com": ["198.51.100.9"] };

    const live = await lookupLiveMailRecords("example.com", required);

    expect(
      isRecordLive(
        required.find((r) => r.purpose === "HOST")!,
        live,
      ),
    ).toBe(false);
  });

  it("does not count a DKIM record carrying a different public key", async () => {
    answers.txt = {
      "default._domainkey.example.com": [
        ["v=DKIM1; k=rsa; p=DIFFERENTKEYVALUE"],
      ],
    };

    const live = await lookupLiveMailRecords("example.com", required);

    expect(
      isRecordLive(
        required.find((r) => r.purpose === "DKIM")!,
        live,
      ),
    ).toBe(false);
  });
});

describe("DnsService.initializeEmailAuthRecords", () => {
  it("writes no records for a CONNECTED domain", async () => {
    const dnsRecord = {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    };
    const prisma = {
      domain: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            id: "d1",
            hostname: "example.com",
            dnsMode: "CONNECTED",
          }),
      },
      dnsRecord,
    } as unknown as PrismaClient;

    const result = await new DnsService(prisma).initializeEmailAuthRecords(
      "u1",
      "d1",
    );

    expect(result).toEqual([]);
    expect(dnsRecord.create).not.toHaveBeenCalled();
  });

  it("still seeds the mail host, SPF, DMARC and MX for a MANAGED domain", async () => {
    const dnsRecord = {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    };
    const prisma = {
      domain: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            id: "d1",
            hostname: "example.com",
            dnsMode: "MANAGED",
          }),
        findUnique: vi.fn().mockResolvedValue({ dnsMode: "MANAGED" }),
      },
      dnsRecord,
    } as unknown as PrismaClient;

    await new DnsService(prisma).initializeEmailAuthRecords("u1", "d1");

    expect(dnsRecord.create).toHaveBeenCalledTimes(4);
  });
});
