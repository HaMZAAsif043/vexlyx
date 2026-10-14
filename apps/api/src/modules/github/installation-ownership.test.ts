import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { AuditLogService } from "../audit-log/service.js";
import type { GitHubClient } from "./client.js";

vi.mock("../../config/env.js", () => ({ env: {} }));
vi.mock("../../utils/encryption.js", () => ({
  decrypt: (value: string) => value,
}));
import { GitHubService } from "./service.js";

function setup(concurrent = false) {
  let stored: Record<string, unknown> | null = null;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  const upsert = vi.fn(async (args: Prisma.GitHubInstallationUpsertArgs) => {
    if (concurrent) {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    }
    if (stored) {
      if (
        args.where.userId !== undefined &&
        stored.userId !== args.where.userId
      ) {
        throw Object.assign(new Error("unique constraint"), { code: "P2002" });
      }
      Object.assign(stored, args.update);
    } else {
      stored = {
        ...args.create,
        id: "local-installation",
        disconnectedAt: null,
      };
    }
    return { ...stored };
  });
  const prisma = {
    gitHubApp: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          appId: 1n,
          clientId: "test",
          encryptedClientSecret: "test",
          encryptedPrivateKey: "test",
        }),
    },
    gitHubInstallation: {
      findUnique: vi.fn(async () => stored && { ...stored }),
      upsert,
    },
  };
  const redis = {
    eval: vi.fn(async (_script: string, _count: number, key: string) =>
      JSON.stringify({
        userId: key.split(":").at(-1),
        sessionId: "session",
        purpose: "installation",
      }),
    ),
  };
  const client = {
    exchangeUserCode: vi.fn().mockResolvedValue("token"),
    listUserInstallations: vi
      .fn()
      .mockResolvedValue({ installations: [{ id: 100 }] }),
    getInstallation: vi
      .fn()
      .mockResolvedValue({
        id: 100,
        account: { id: 2, login: "org", type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      }),
  };
  const audit = { log: vi.fn() };
  const service = new GitHubService(
    prisma as unknown as PrismaClient,
    redis as unknown as Redis,
    audit as unknown as AuditLogService,
    client as unknown as GitHubClient,
  );
  return {
    upsert,
    audit,
    client,
    owner: () => stored?.userId,
    link: (userId: string) =>
      service.completeInstallation(userId, "session", userId, "code", "100"),
  };
}

describe("GitHub installation ownership", () => {
  it("allows only one owner when two callbacks reach the write concurrently", async () => {
    const { link, owner, audit } = setup(true);
    const results = await Promise.allSettled([link("first"), link("second")]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "GITHUB_INSTALLATION_ALREADY_LINKED", statusCode: 409 },
    });
    expect(owner()).toBe("first");
    expect(audit.log).toHaveBeenCalledExactlyOnceWith(
      "first",
      "github.installation_linked",
      expect.anything(),
      expect.anything(),
    );
  });

  it("lets the same owner reconnect without updating the owner field", async () => {
    const { link, upsert, owner } = setup();
    await link("first");
    await link("first");
    expect(owner()).toBe("first");
    expect(upsert.mock.calls[1]![0].update).not.toHaveProperty("userId");
    expect(upsert.mock.calls[1]![0].where).toMatchObject({
      installationId: 100n,
      userId: "first",
    });
  });

  it("rejects another owner without changing the existing record", async () => {
    const { link, owner } = setup();
    await link("first");
    await expect(link("second")).rejects.toMatchObject({
      code: "GITHUB_INSTALLATION_ALREADY_LINKED",
    });
    expect(owner()).toBe("first");
  });

  it("preserves unrelated database errors", async () => {
    const { link, upsert, audit } = setup();
    const failure = new Error("unavailable");
    upsert.mockRejectedValueOnce(failure);
    await expect(link("first")).rejects.toBe(failure);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("requires GitHub authorization before attempting the write", async () => {
    const { link, client, upsert } = setup();
    client.listUserInstallations.mockResolvedValue({ installations: [] });
    await expect(link("first")).rejects.toMatchObject({
      code: "GITHUB_INSTALLATION_MISMATCH",
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
