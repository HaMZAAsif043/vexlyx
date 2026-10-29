import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/env.js", () => ({
  env: {
    API_BASE_URL: "https://api.vexlyx.example",
    CORS_ORIGIN: "https://vexlyx.example",
  },
}));
vi.mock("../../utils/encryption.js", () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
}));

import { GitHubService } from "./service.js";

describe("GitHubService.createManifest", () => {
  it("uses GitHub's supported OAuth-on-install manifest key", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };
    const service = new GitHubService({} as never, redis as never, {} as never);

    const { url, manifest } = await service.createManifest("user-1", "session-1");

    expect(manifest).toHaveProperty("request_oauth_on_install", true);
    expect(manifest).not.toHaveProperty("request_oauth_on_installation");
    expect(manifest.redirect_url).toBe("https://api.vexlyx.example/api/github/app/manifest/callback");
    expect(new URL(url).searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("GitHubService.configureApp", () => {
  function setup(existingAppId: bigint | null) {
    const transaction = {
      gitHubApp: {
        upsert: vi.fn(async () => ({ appId: 2n, slug: "replacement" })),
      },
      gitHubInstallation: { updateMany: vi.fn(async () => ({ count: 1 })) },
      project: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      gitHubApp: {
        findUnique: vi.fn(async () => existingAppId === null ? null : { appId: existingAppId }),
      },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const client = {
      getApp: vi.fn(async () => ({ id: 2, slug: "replacement", client_id: "client-2" })),
    };
    const service = new GitHubService(prisma as never, {} as never, { log: vi.fn() } as never, client as never);
    return { service, transaction };
  }

  const input = {
    appId: "2",
    slug: "replacement",
    clientId: "client-2",
    clientSecret: "secret",
    privateKey: "private-key",
    webhookSecret: "webhook-secret",
  };

  it("disconnects installations and projects when a different App replaces the current one", async () => {
    const { service, transaction } = setup(1n);

    await service.configureApp("user-1", input);

    expect(transaction.gitHubInstallation.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { status: { not: "DISCONNECTED" } },
      data: { status: "DISCONNECTED", suspendedAt: null, disconnectedAt: expect.any(Date) },
    });
    expect(transaction.project.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { githubInstallationId: { not: null }, githubConnectionStatus: { not: "DISCONNECTED" } },
      data: {
        githubConnectionStatus: "DISCONNECTED",
        githubDisconnectReason: "GitHub App was replaced; reconnect the installation",
      },
    });
  });

  it("keeps installations connected when only the current App credentials change", async () => {
    const { service, transaction } = setup(2n);

    await service.configureApp("user-1", input);

    expect(transaction.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    expect(transaction.project.updateMany).not.toHaveBeenCalled();
  });
});
