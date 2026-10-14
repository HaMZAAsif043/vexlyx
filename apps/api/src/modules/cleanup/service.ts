import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { DiskUsageResponse, CleanupTrigger } from "@vexlyx/shared";
import { getPythonBin } from "../../utils/pythonBin.js";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "../../utils/processWatchdog.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CleanupError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "CleanupError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate docker_manager.py (mirrors deploy/service.ts, monitoring/service.ts)
// ---------------------------------------------------------------------------

function getDockerManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/docker_manager.py"),
    resolve(currentDir, "../../../../system/python/docker_manager.py"),
    resolve(process.cwd(), "../../system/python/docker_manager.py"),
    resolve(process.cwd(), "system/python/docker_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/docker_manager.py");
}

// ---------------------------------------------------------------------------
// Helper — run a docker_manager.py command (mirrors backups/service.ts's
// runBackupCommand: JSON-line stdout, PYTHON_BIN override, log passthrough)
// ---------------------------------------------------------------------------

function runDockerManagerCommand<T>(
  payload: Record<string, unknown>,
  logger: FastifyBaseLogger,
  onLog?: (message: string) => void,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = getDockerManagerScriptPath();
    const body = JSON.stringify(payload);
    const pythonBin = getPythonBin();

    const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.cleanup, (ms) =>
      reject(
        new CleanupError(
          `Docker cleanup timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";
    let result: unknown = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed && typeof parsed === "object" && "log" in parsed) {
          onLog?.((parsed as { log: string }).log);
        } else {
          result = parsed;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ err }, "docker_manager.py spawn error");
      reject(new CleanupError(`Failed to start docker_manager.py: ${err.message}`, "SPAWN_ERROR", 500));
    });

    child.on("close", (code) => {
      const trailing = stdout.trim();
      if (trailing) {
        try {
          const parsed = JSON.parse(trailing);
          if (parsed && typeof parsed === "object" && "log" in parsed) {
            onLog?.((parsed as { log: string }).log);
          } else {
            result = parsed;
          }
        } catch {
          // ignore trailing partial output
        }
      }

      if (stderr) {
        logger.debug({ stderr }, "docker_manager.py stderr output");
      }

      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof (result as Record<string, unknown>).error === "string"
      ) {
        const err = result as { error: string; code?: string };
        reject(new CleanupError(err.error, err.code ?? "DOCKER_MANAGER_ERROR", 500));
        return;
      }

      if (result === null) {
        const message = stderr.trim()
          ? `docker_manager.py exited with code ${code}: ${stderr.trim().slice(0, 2000)}`
          : `docker_manager.py exited with code ${code} and no output`;
        reject(new CleanupError(message, "EMPTY_OUTPUT", 500));
        return;
      }

      if (code !== 0) {
        reject(new CleanupError(`docker_manager.py exited with code ${code}`, "SCRIPT_ERROR", 500));
        return;
      }

      resolvePromise(result as T);
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CleanupService {
  constructor(
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
  ) {}

  async getDiskUsage(): Promise<DiskUsageResponse> {
    return runDockerManagerCommand<DiskUsageResponse>({ command: "system_df" }, this.logger);
  }

  async getSettings() {
    const existing = await this.prisma.cleanupSettings.findUnique({ where: { id: "default" } });
    if (existing) return existing;

    return this.prisma.cleanupSettings.create({ data: { id: "default" } });
  }

  async updateSettings(data: { scheduleEnabled: boolean; scheduleCron: string; pruneAfterRedeploy: boolean }) {
    return this.prisma.cleanupSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
  }

  async getHistory() {
    const runs = await this.prisma.cleanupRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return runs.map((r) => ({
      ...r,
      reclaimedBytes: r.reclaimedBytes !== null ? Number(r.reclaimedBytes) : null,
    }));
  }

  /**
   * Runs `docker container prune` + `docker image prune -a` and records the
   * result as a CleanupRun row. Used by both the manual-trigger route and
   * the scheduled BullMQ job.
   */
  async runCleanup(trigger: CleanupTrigger) {
    const run = await this.prisma.cleanupRun.create({ data: { trigger } });

    try {
      const result = await runDockerManagerCommand<{
        containersRemoved: number;
        imagesRemoved: number;
        reclaimedBytes: number;
      }>({ command: "cleanup" }, this.logger);

      return await this.prisma.cleanupRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          containersRemoved: result.containersRemoved,
          imagesRemoved: result.imagesRemoved,
          reclaimedBytes: BigInt(Math.round(result.reclaimedBytes)),
          completedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown cleanup error";
      this.logger.error({ err, runId: run.id }, "Cleanup run failed");
      return this.prisma.cleanupRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
    }
  }

  /**
   * Resolves the current image ID for a tag, or null if the tag doesn't
   * exist yet (first deploy). Used by the build job to capture the
   * "previous image" before a rebuild retags it.
   */
  async getImageId(imageName: string): Promise<string | null> {
    const result = await runDockerManagerCommand<{ imageId: string | null }>(
      { command: "image_id", imageName },
      this.logger,
    );
    return result.imageId;
  }

  /**
   * Removes a superseded image after a redeploy is confirmed healthy
   * (F5.15 AC #4). No-ops (rather than errors) if the image is still in
   * use, and never blocks/fails the deployment it's called from.
   */
  async pruneAfterRedeploy(oldImageId: string): Promise<void> {
    const run = await this.prisma.cleanupRun.create({ data: { trigger: "REDEPLOY" } });

    try {
      const result = await runDockerManagerCommand<{ removed: boolean }>(
        { command: "remove_image", imageId: oldImageId },
        this.logger,
      );

      await this.prisma.cleanupRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          imagesRemoved: result.removed ? 1 : 0,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown cleanup error";
      this.logger.warn({ err, oldImageId }, "Post-redeploy image cleanup failed");
      await this.prisma.cleanupRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
    }
  }
}
