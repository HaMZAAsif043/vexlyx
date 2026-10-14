import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { ServerMetrics, ContainerMetric, MetricsRange } from "@vexlyx/shared";
import { ServerMetricsSchema, ContainerMetricSchema } from "@vexlyx/shared";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MonitoringError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "MonitoringError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate system_monitor.py
// ---------------------------------------------------------------------------

function getSystemMonitorScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/system_monitor.py"),
    resolve(currentDir, "../../../../system/python/system_monitor.py"),
    resolve(process.cwd(), "../../system/python/system_monitor.py"),
    resolve(process.cwd(), "system/python/system_monitor.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return (
    candidates[0] ?? resolve(process.cwd(), "system/python/system_monitor.py")
  );
}

// ---------------------------------------------------------------------------
// Helper — run a system_monitor.py command and resolve the result
// ---------------------------------------------------------------------------

function runMonitorCommand<T>(command: string, logger: FastifyBaseLogger): Promise<T> {
  return new Promise((resolve, reject) => {
    const scriptPath = getSystemMonitorScriptPath();
    const payload = JSON.stringify({ command });

    const pythonBin = getPythonBin();

    const child = spawn(pythonBin, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ command, err }, "system_monitor.py spawn error");
      reject(
        new MonitoringError(
          `Failed to start monitoring script: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (stderr) {
        logger.debug({ command, stderr }, "system_monitor.py stderr output");
      }

      const line = stdout.trim().split("\n").pop() ?? "";
      if (!line) {
        reject(
          new MonitoringError(
            "Monitoring script produced no output",
            "EMPTY_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(
          new MonitoringError(
            `Monitoring script returned invalid JSON: ${line.slice(0, 100)}`,
            "INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as Record<string, unknown>).error === "string"
      ) {
        const err = parsed as { error: string; code?: string };
        reject(
          new MonitoringError(err.error, err.code ?? "MONITOR_ERROR", 500),
        );
        return;
      }

      if (code !== 0) {
        reject(
          new MonitoringError(
            `Monitoring script exited with code ${code}`,
            "SCRIPT_ERROR",
            500,
          ),
        );
        return;
      }

      resolve(parsed as T);
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Range → milliseconds helper for DB queries
// ---------------------------------------------------------------------------

function rangeToMs(range: MetricsRange): number {
  switch (range) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MonitoringService {
  constructor(
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
  ) {}

  async getServerMetrics(): Promise<ServerMetrics> {
    const raw = await runMonitorCommand<Record<string, unknown>>(
      "server_metrics",
      this.logger,
    );
    return ServerMetricsSchema.parse(raw);
  }

  async getContainerMetrics(): Promise<ContainerMetric[]> {
    const raw = await runMonitorCommand<{ containers: unknown[] }>(
      "container_metrics",
      this.logger,
    );
    return (raw.containers ?? []).map((c) => ContainerMetricSchema.parse(c));
  }

  async getHistory(range: MetricsRange) {
    const since = new Date(Date.now() - rangeToMs(range));

    const snapshots = await this.prisma.metricSnapshot.findMany({
      where: { recordedAt: { gte: since } },
      orderBy: { recordedAt: "asc" },
      select: {
        id: true,
        cpuPercent: true,
        ramUsed: true,
        ramTotal: true,
        diskUsed: true,
        diskTotal: true,
        recordedAt: true,
      },
    });

    return snapshots.map((s) => ({
      ...s,
      // BigInt fields → number for JSON serialisation
      ramUsed: Number(s.ramUsed),
      ramTotal: Number(s.ramTotal),
      diskUsed: Number(s.diskUsed),
      diskTotal: Number(s.diskTotal),
      recordedAt: s.recordedAt.toISOString(),
    }));
  }

  async saveSnapshot(metrics: ServerMetrics): Promise<void> {
    await this.prisma.metricSnapshot.create({
      data: {
        cpuPercent: metrics.cpuPercent,
        ramUsed: BigInt(metrics.ramUsed),
        ramTotal: BigInt(metrics.ramTotal),
        diskUsed: BigInt(metrics.diskUsed),
        diskTotal: BigInt(metrics.diskTotal),
      },
    });
  }

  async pruneOldSnapshots(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await this.prisma.metricSnapshot.deleteMany({
      where: { recordedAt: { lt: cutoff } },
    });
  }
}
