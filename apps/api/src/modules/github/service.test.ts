import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/encryption.js", () => ({ decrypt: (value: string) => value }));

vi.mock("../../config/env.js", () => ({
  env: {
    API_BASE_URL: "https://api.vexlyx.example",
    CORS_ORIGIN: "https://vexlyx.example",
  },
}));

import { GitHubApiError } from "./client.js";
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

it("preserves timeout errors during installation token minting", async () => {
  const prisma = { gitHubApp: { findUnique: vi.fn(async () => ({ appId: 1n, encryptedPrivateKey: "unused" })) } };
  const client = { createInstallationToken: vi.fn().mockRejectedValue(new GitHubApiError("Timed out", 504, "GITHUB_API_TIMEOUT")) };
  const service = new GitHubService(prisma as never, {} as never, {} as never, client as never);
  await expect(service.getInstallationToken(987654n)).rejects.toMatchObject({ code: "GITHUB_API_TIMEOUT", statusCode: 504 });
});
