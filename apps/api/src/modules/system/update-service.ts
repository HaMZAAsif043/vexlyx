import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import { VEXLYX_VERSION } from "@vexlyx/shared";
import {
  SystemUpdateInfoSchema,
  type SystemUpdateInfo,
} from "@vexlyx/shared/schemas/systemUpdate";
import { env } from "../../config/env.js";
import { isNewerVersion } from "../../utils/version.js";

const CACHE_KEY = "system:update-info";
const SUCCESS_TTL_SECONDS = 6 * 60 * 60;
// A failed check is cached for less time than a successful one: a briefly
// unreachable GitHub should not hide a release for six hours, while the panel
// still must not call the API on every page load.
const FAILURE_TTL_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 5_000;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Compares the running version against the newest stable GitHub release.
 * Results (including failures) are cached in Redis so the dashboard can poll
 * freely and the API stays well inside GitHub's unauthenticated rate limit.
 */
export class SystemUpdateService {
  constructor(
    private readonly redis: Redis,
    private readonly log: FastifyBaseLogger,
  ) {}

  async getUpdateInfo(): Promise<SystemUpdateInfo> {
    if (!env.UPDATE_CHECK_ENABLED) {
      return {
        currentVersion: VEXLYX_VERSION,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        publishedAt: null,
        checkedAt: new Date().toISOString(),
        checkEnabled: false,
        checkFailed: false,
      };
    }

    const cached = await this.readCache();
    if (cached) return cached;

    return this.checkLatestRelease();
  }

  private async checkLatestRelease(): Promise<SystemUpdateInfo> {
    const checkedAt = new Date().toISOString();

    try {
      const response = await fetch(
        `https://api.github.com/repos/${env.UPDATE_CHECK_REPO}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": `Vexlyx/${VEXLYX_VERSION}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub responded with ${response.status}`);
      }

      const release = (await response.json()) as GitHubRelease;
      if (!release.tag_name) {
        throw new Error("GitHub's latest release has no tag name");
      }
      if (release.draft || release.prerelease) {
        throw new Error("GitHub's latest release is a draft or prerelease");
      }

      const latestVersion = release.tag_name.replace(/^v/, "");
      const info: SystemUpdateInfo = {
        currentVersion: VEXLYX_VERSION,
        latestVersion,
        updateAvailable: isNewerVersion(latestVersion, VEXLYX_VERSION),
        releaseUrl: release.html_url ?? null,
        publishedAt: release.published_at ?? null,
        checkedAt,
        checkEnabled: true,
        checkFailed: false,
      };
      await this.writeCache(info, SUCCESS_TTL_SECONDS);
      return info;
    } catch (err) {
      this.log.warn({ err }, "Update check against GitHub failed");
      const info: SystemUpdateInfo = {
        currentVersion: VEXLYX_VERSION,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
        publishedAt: null,
        checkedAt,
        checkEnabled: true,
        checkFailed: true,
      };
      await this.writeCache(info, FAILURE_TTL_SECONDS);
      return info;
    }
  }

  private async readCache(): Promise<SystemUpdateInfo | null> {
    try {
      const raw = await this.redis.get(CACHE_KEY);
      if (!raw) return null;
      const parsed = SystemUpdateInfoSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.log.warn({ err }, "Could not read the update-check cache");
      return null;
    }
  }

  private async writeCache(info: SystemUpdateInfo, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.setex(CACHE_KEY, ttlSeconds, JSON.stringify(info));
    } catch (err) {
      this.log.warn({ err }, "Could not cache the update-check result");
    }
  }
}
