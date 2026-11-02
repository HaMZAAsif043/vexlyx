import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  UPDATE_CHECK_ENABLED: true,
  UPDATE_CHECK_REPO: "atlantiqshq/vexlyx",
}));

vi.mock("../../config/env.js", () => ({ env: mockEnv }));

const { SystemUpdateService } = await import("./update-service.js");

function createRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    }),
  };
}

function createLogger() {
  return { warn: vi.fn() };
}

function githubRelease(tag: string) {
  return {
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: `https://github.com/atlantiqshq/vexlyx/releases/tag/${tag}`,
      published_at: "2026-10-30T09:00:00Z",
    }),
  };
}

describe("SystemUpdateService", () => {
  const redis = createRedis();
  const log = createLogger();
  const service = new SystemUpdateService(
    redis as unknown as Redis,
    log as unknown as FastifyBaseLogger,
  );

  beforeEach(() => {
    redis.store.clear();
    redis.get.mockClear();
    redis.setex.mockClear();
    log.warn.mockClear();
    mockEnv.UPDATE_CHECK_ENABLED = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an update when the latest release is newer", async () => {
    const fetchMock = vi.fn(async () => githubRelease("v999.0.0"));
    vi.stubGlobal("fetch", fetchMock);

    const info = await service.getUpdateInfo();

    expect(info).toMatchObject({
      latestVersion: "999.0.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/atlantiqshq/vexlyx/releases/tag/v999.0.0",
      publishedAt: "2026-10-30T09:00:00Z",
      checkEnabled: true,
      checkFailed: false,
    });
    expect(info.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it("reports no update when the release matches or trails the running version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => githubRelease("v0.0.1")));

    const info = await service.getUpdateInfo();

    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("0.0.1");
    expect(info.checkFailed).toBe(false);
  });

  it("returns a checkFailed result instead of throwing when GitHub is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const info = await service.getUpdateInfo();

    expect(info).toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      checkEnabled: true,
      checkFailed: true,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("serves a cached result without calling GitHub again", async () => {
    const fetchMock = vi.fn(async () => githubRelease("v999.0.0"));
    vi.stubGlobal("fetch", fetchMock);
    await service.getUpdateInfo();

    const second = await service.getUpdateInfo();

    expect(second.updateAvailable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks when the cached payload is unreadable", async () => {
    redis.store.set("system:update-info", "not json");
    const fetchMock = vi.fn(async () => githubRelease("v999.0.0"));
    vi.stubGlobal("fetch", fetchMock);

    const info = await service.getUpdateInfo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(info.updateAvailable).toBe(true);
  });

  it("skips the network entirely when the check is disabled", async () => {
    mockEnv.UPDATE_CHECK_ENABLED = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const info = await service.getUpdateInfo();

    expect(info).toMatchObject({
      checkEnabled: false,
      checkFailed: false,
      latestVersion: null,
      updateAvailable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
