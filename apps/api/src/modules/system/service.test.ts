import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const dnsAnswers = vi.hoisted(() => ({
  a: {} as Record<string, string[]>,
  mx: {} as Record<string, Array<{ exchange: string; priority: number }>>,
}));
const mockEnv = vi.hoisted(() => ({
  PANEL_DOMAIN: "panel.example.com",
  BASE_DOMAIN: "apps.example.com",
  PUBLIC_IP: "203.0.113.10",
  HOSTED_MAIL_HOSTNAME: "mx1.mailhost.net",
  HOSTED_MAIL_DOMAIN: "example.org",
}));

vi.mock("node:dns", () => {
  class Resolver {
    setServers() {}

    async resolve4(host: string) {
      const answer = dnsAnswers.a[host];
      if (!answer)
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return answer;
    }

    async resolveMx(host: string) {
      const answer = dnsAnswers.mx[host];
      if (!answer)
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return answer;
    }
  }

  return { default: { promises: { Resolver } } };
});

vi.mock("../../config/env.js", () => ({
  env: mockEnv,
}));

const { SystemService } = await import("./service.js");
const service = new SystemService({} as PrismaClient);

describe("SystemService DNS onboarding", () => {
  beforeEach(() => {
    dnsAnswers.a = {};
    dnsAnswers.mx = {};
    mockEnv.HOSTED_MAIL_HOSTNAME = "mx1.mailhost.net";
    mockEnv.HOSTED_MAIL_DOMAIN = "example.org";
  });

  it("includes the default mail hostname and domain", () => {
    mockEnv.HOSTED_MAIL_HOSTNAME = "mail.panel.example.com";
    mockEnv.HOSTED_MAIL_DOMAIN = "panel.example.com";

    expect(service.getDnsOnboardingInfo().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "A", host: "mail.panel.example.com" }),
        expect.objectContaining({
          type: "MX",
          host: "panel.example.com",
          value: "mail.panel.example.com",
          priority: 10,
        }),
      ]),
    );
  });

  it("includes configured inbound mail A and MX records", () => {
    expect(service.getDnsOnboardingInfo().records).toEqual(
      expect.arrayContaining([
        {
          type: "A",
          host: "mx1.mailhost.net",
          value: "203.0.113.10",
          priority: undefined,
          purpose: "Inbound mail server",
        },
        {
          type: "MX",
          host: "example.org",
          value: "mx1.mailhost.net",
          priority: 10,
          purpose: "Inbound mail routing",
        },
      ]),
    );
  });

  it("verifies A and MX records including MX priority", async () => {
    dnsAnswers.a = {
      "panel.example.com": ["203.0.113.10"],
      "api.panel.example.com": ["203.0.113.10"],
      "webmail.panel.example.com": ["203.0.113.10"],
      "vexlyx-dns-check.apps.example.com": ["203.0.113.10"],
      "mx1.mailhost.net": ["203.0.113.10"],
    };
    dnsAnswers.mx = {
      "example.org": [{ exchange: "MX1.MAILHOST.NET.", priority: 10 }],
    };

    const result = await service.verifyDnsRecords();

    expect(result.results).toHaveLength(6);
    expect(result.results.every((record) => record.isPropagated)).toBe(true);
    expect(result.results.find((record) => record.type === "MX")).toMatchObject(
      {
        host: "example.org",
        expected: "mx1.mailhost.net",
        isPropagated: true,
      },
    );
  });

  it("rejects an MX record with the wrong priority", async () => {
    dnsAnswers.mx = {
      "example.org": [{ exchange: "mx1.mailhost.net", priority: 20 }],
    };

    const result = await service.verifyDnsRecords();

    expect(
      result.results.find((record) => record.type === "MX")?.isPropagated,
    ).toBe(false);
  });
});
