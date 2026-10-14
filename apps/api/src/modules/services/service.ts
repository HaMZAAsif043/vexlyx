import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type {
  ServiceName,
  ServiceAction,
  ServicesStatusResponse,
  ServiceStatusResponse,
  ServiceLogsResponse,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ServicesError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ServicesError";
  }
}

// ---------------------------------------------------------------------------
// Managed service → container name map (whitelist, driven by env config)
// ---------------------------------------------------------------------------

const CONTAINER_NAMES: Record<ServiceName, string> = {
  postfix: env.POSTFIX_CONTAINER_NAME,
  dovecot: env.DOVECOT_CONTAINER_NAME,
  coredns: env.COREDNS_CONTAINER_NAME,
  postgres: env.POSTGRES_CONTAINER_NAME,
  redis: env.REDIS_CONTAINER_NAME,
};

// ---------------------------------------------------------------------------
// Helper — locate service_status_manager.py (mirrors firewall/service.ts)
// ---------------------------------------------------------------------------

function getServiceStatusScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/service_status_manager.py"),
    resolve(currentDir, "../../../../system/python/service_status_manager.py"),
    resolve(process.cwd(), "../../system/python/service_status_manager.py"),
    resolve(process.cwd(), "system/python/service_status_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/service_status_manager.py");
}

// ---------------------------------------------------------------------------
// Helper — run a service_status_manager.py command and resolve the result
// ---------------------------------------------------------------------------

function runServiceStatusCommand<T>(payload: Record<string, unknown>, logger: FastifyBaseLogger): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = getServiceStatusScriptPath();
    const body = JSON.stringify({
      containers: Object.values(CONTAINER_NAMES),
      ...payload,
    });

    const pythonBin = getPythonBin();

    const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ err }, "service_status_manager.py spawn error");
      reject(new ServicesError(`Failed to start service status script: ${err.message}`, "SPAWN_ERROR", 500));
    });

    child.on("close", (code) => {
      if (stderr) {
        logger.debug({ stderr }, "service_status_manager.py stderr output");
      }

      const line = stdout.trim().split("\n").pop() ?? "";
      if (!line) {
        reject(new ServicesError("Service status script produced no output", "EMPTY_OUTPUT", 500));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(
          new ServicesError(`Service status script returned invalid JSON: ${line.slice(0, 100)}`, "INVALID_JSON", 500),
        );
        return;
      }

      if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as Record<string, unknown>).error === "string") {
        const err = parsed as { error: string; code?: string };
        const statusCode = err.code === "UNKNOWN_CONTAINER" || err.code === "INVALID_PAYLOAD" ? 400 : 500;
        reject(new ServicesError(err.error, err.code ?? "SERVICE_STATUS_SCRIPT_ERROR", statusCode));
        return;
      }

      if (code !== 0) {
        reject(new ServicesError(`Service status script exited with code ${code}`, "SCRIPT_ERROR", 500));
        return;
      }

      resolvePromise(parsed as T);
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Live status shape, as parsed by service_status_manager.py's `status` command
// ---------------------------------------------------------------------------

interface LiveServiceStatus {
  container: string;
  status: "running" | "stopped" | "unknown";
  startedAt: string | null;
}

interface LiveStatus {
  services: LiveServiceStatus[];
  dockerDaemon: { running: boolean };
}

function uptimeSecondsFrom(startedAt: string | null): number | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ServicesService {
  constructor(private logger: FastifyBaseLogger) {}

  async getStatus(): Promise<ServicesStatusResponse> {
    const live = await runServiceStatusCommand<LiveStatus>({ command: "status" }, this.logger);

    const byContainer = new Map(live.services.map((s) => [s.container, s]));

    const services: ServiceStatusResponse[] = (Object.keys(CONTAINER_NAMES) as ServiceName[]).map((name) => {
      const containerName = CONTAINER_NAMES[name];
      const liveEntry = byContainer.get(containerName);
      return {
        name,
        containerName,
        status: liveEntry?.status ?? "unknown",
        uptimeSeconds: uptimeSecondsFrom(liveEntry?.startedAt ?? null),
      };
    });

    return { services, dockerDaemon: live.dockerDaemon };
  }

  async performAction(name: ServiceName, action: ServiceAction): Promise<void> {
    await runServiceStatusCommand(
      { command: action, container: CONTAINER_NAMES[name] },
      this.logger,
    );
  }

  async getLogs(name: ServiceName, tail: number): Promise<ServiceLogsResponse> {
    return runServiceStatusCommand<ServiceLogsResponse>(
      { command: "logs", container: CONTAINER_NAMES[name], tail },
      this.logger,
    );
  }
}
