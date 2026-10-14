import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket, Server as SocketIOServer } from "socket.io";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LogsError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "LogsError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate docker_manager.py (mirrors deploy/service.ts)
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
// Build log replay — sends persisted logs to a newly-joined socket
// ---------------------------------------------------------------------------

export async function replayBuildLogs(
  prisma: PrismaClient,
  deploymentId: string,
  socket: Socket,
): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { buildLogs: true, projectId: true },
  });

  if (!deployment) return;

  const raw = deployment.buildLogs ?? "";
  if (!raw.trim()) return;

  // Split on newlines, cap replay at 1000 lines
  const lines = raw.split("\n").filter(Boolean);
  const capped = lines.slice(-1000);

  socket.emit("log:history", { lines: capped });
}

// ---------------------------------------------------------------------------
// Runtime log streaming via docker logs --follow
// Spawns a persistent subprocess per socket; cleaned up on disconnect.
// ---------------------------------------------------------------------------

interface RuntimeLogProcess {
  kill(): void;
}

// Track active streaming processes keyed by socketId+projectId
const activeStreams = new Map<string, RuntimeLogProcess>();

export function startRuntimeLogStream(
  projectDir: string,
  projectId: string,
  projectType: string,
  socket: Socket,
  logger: FastifyBaseLogger,
): void {
  const streamKey = `${socket.id}:${projectId}`;

  // Avoid duplicate streams for the same socket
  if (activeStreams.has(streamKey)) return;

  if (!existsSync(projectDir)) {
    socket.emit("log:runtime:error", { message: "Project directory not found" });
    return;
  }

  const scriptPath = getDockerManagerScriptPath();
  const payload = JSON.stringify({ command: "logs_follow", projectDir, projectType });

  const child = spawn(getPythonBin(), [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to parse JSON lines from docker_manager.py
      let stream: "stdout" | "stderr" = "stdout";
      let text = trimmed;

      try {
        const parsed = JSON.parse(trimmed) as { log?: string; stream?: string; error?: string };
        if (parsed.error) {
          socket.emit("log:runtime:error", { message: parsed.error });
          continue;
        }
        text = parsed.log ?? trimmed;
        stream = (parsed.stream === "stderr" ? "stderr" : "stdout") as "stdout" | "stderr";
      } catch {
        // Not JSON — treat as plain stdout line
      }

      socket.emit("log:runtime", { line: text, stream, ts: Date.now() });
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      socket.emit("log:runtime", { line: line.trim(), stream: "stderr" as const, ts: Date.now() });
    }
  });

  child.on("error", (err) => {
    logger.error({ projectId, err }, "Runtime log stream spawn error");
    socket.emit("log:runtime:error", { message: err.message });
    activeStreams.delete(streamKey);
  });

  child.on("close", () => {
    activeStreams.delete(streamKey);
  });

  child.stdin.write(payload);
  child.stdin.end();

  activeStreams.set(streamKey, {
    kill() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    },
  });
}

export function stopRuntimeLogStream(projectId: string, socket: Socket): void {
  const streamKey = `${socket.id}:${projectId}`;
  const proc = activeStreams.get(streamKey);
  if (proc) {
    proc.kill();
    activeStreams.delete(streamKey);
  }
}

// ---------------------------------------------------------------------------
// Register socket event handlers — called once per connection from routes.ts
// ---------------------------------------------------------------------------

export function registerSocketHandlers(
  io: SocketIOServer,
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
): void {
  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;

    // --- Build log subscription ---
    socket.on("subscribe:build", async ({ deploymentId }: { deploymentId: string }) => {
      if (typeof deploymentId !== "string") return;

      // Verify deployment belongs to this user before joining the room
      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { project: { select: { userId: true } } },
      });

      if (!deployment || deployment.project.userId !== userId) {
        socket.emit("error", { code: "FORBIDDEN" });
        return;
      }

      const room = `deployment:${deploymentId}`;
      await socket.join(room);

      // Replay persisted log lines immediately on join
      await replayBuildLogs(prisma, deploymentId, socket);

      logger.debug({ socketId: socket.id, deploymentId }, "Subscribed to build logs");
    });

    // --- Runtime log subscription ---
    socket.on("subscribe:runtime", async ({ projectId }: { projectId: string }) => {
      if (typeof projectId !== "string") return;

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { userId: true, type: true, deletedAt: true },
      });

      if (!project || project.deletedAt !== null || project.userId !== userId) {
        socket.emit("error", { code: "FORBIDDEN" });
        return;
      }

      const room = `container:${projectId}`;
      await socket.join(room);

      // Resolve project dir (mirrors deploy/service.ts pattern)
      const { env } = await import("../../config/env.js");
      const projectDir = resolve(env.PROJECTS_DIR, projectId);

      startRuntimeLogStream(projectDir, projectId, project.type, socket, logger);
      logger.debug({ socketId: socket.id, projectId }, "Subscribed to runtime logs");
    });

    // --- Runtime log unsubscribe ---
    socket.on("unsubscribe:runtime", ({ projectId }: { projectId: string }) => {
      if (typeof projectId !== "string") return;
      stopRuntimeLogStream(projectId, socket);
      void socket.leave(`container:${projectId}`);
    });

    // --- Cleanup all streams on disconnect ---
    socket.on("disconnect", () => {
      // Kill any active runtime streams for this socket
      for (const [key] of activeStreams) {
        if (key.startsWith(`${socket.id}:`)) {
          activeStreams.get(key)?.kill();
          activeStreams.delete(key);
        }
      }
    });
  });
}
