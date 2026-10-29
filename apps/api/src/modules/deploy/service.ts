import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { EnvService, EnvError } from "../env/service.js";
import type { DeployBody } from "./schema.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "../../utils/processWatchdog.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeployError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate docker_manager.py
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
// Helper — execute docker_manager.py commands
// ---------------------------------------------------------------------------

interface DockerManagerLine {
  log?: string;
  done?: boolean;
  containerId?: string;
  hostPort?: number;
  hostname?: string;
  containerStatus?: string;
  logs?: string;
  error?: string;
  code?: string;
}

export interface DeployResult {
  containerId: string;
  hostPort: number;
  hostname: string;
}

export function runDockerDeploy(
  payload: {
    projectId: string;
    projectName: string;
    projectDir: string;
    imageName: string;
    projectType: string;
    baseDomain: string;
    memoryLimit: string;
    portRangeStart: number;
    portRangeEnd: number;
    hostPort?: number | null;
    containerPort?: number | null;
    domain?: string | null;
    envVars?: Record<string, string>;
    /** F5.7 — host dir to bind-mount as the nginx webroot for STATIC/REACT. */
    staticRoot?: string;
    /** F5.21 — PHP-FPM image for no-build PHP deploys (docker/php-fpm). */
    phpFpmImage?: string;
  },
  onLog?: (line: string) => Promise<void> | void,
): Promise<DeployResult> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getDockerManagerScriptPath();
    const fullPayload = JSON.stringify({
      command: "deploy",
      ...payload,
    });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.compose, (ms) =>
      rejectP(
        new DeployError(
          `Docker deploy timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let buffer = "";
    let stderrBuffer = "";
    let deployResult: DeployResult | null = null;

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: DockerManagerLine;
        try {
          parsed = JSON.parse(trimmed) as DockerManagerLine;
        } catch {
          if (onLog) void onLog(trimmed);
          continue;
        }

        if (parsed.error) {
          rejectP(new DeployError(parsed.error, parsed.code ?? "DOCKER_DEPLOY_ERROR", 422));
          return;
        }

        if (parsed.log && onLog) {
          void onLog(parsed.log);
        }

        if (parsed.done && parsed.containerId !== undefined) {
          deployResult = {
            containerId: parsed.containerId ?? "",
            hostPort: parsed.hostPort ?? 0,
            hostname: parsed.hostname ?? "",
          };
        }
      }
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim()) as DockerManagerLine;
          if (parsed.done && parsed.containerId !== undefined) {
            deployResult = {
              containerId: parsed.containerId ?? "",
              hostPort: parsed.hostPort ?? 0,
              hostname: parsed.hostname ?? "",
            };
          }
        } catch {
          if (onLog) void onLog(buffer.trim());
        }
      }

      if (code !== 0) {
        const errDetails = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : "";
        rejectP(
          new DeployError(
            `docker_manager.py (deploy) exited with code ${code}${errDetails}`,
            "DOCKER_NONZERO_EXIT",
            422,
          ),
        );
      } else if (deployResult) {
        resolveP(deployResult);
      } else {
        rejectP(
          new DeployError(
            "docker_manager.py (deploy) finished without returning container info",
            "DOCKER_NO_RESULT",
            500,
          ),
        );
      }
    });

    child.on("error", (err) => {
      rejectP(
        new DeployError(
          `Failed to spawn docker_manager.py: ${err.message}`,
          "DOCKER_MANAGER_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(fullPayload);
    child.stdin.end();
  });
}

export function runDockerAction(
  action: "start" | "stop" | "restart" | "remove",
  projectDir: string,
  onLog?: (line: string) => Promise<void> | void,
): Promise<void> {
  return runDockerManagerCommand({ command: action, projectDir }, onLog);
}

/**
 * Stops (and verifies stopped) every container of a project by its identity,
 * for when its workspace directory, and so its compose file, is gone.
 */
export function runDockerStopByProject(projectId: string): Promise<void> {
  return runDockerManagerCommand({ command: "stop_by_project", projectId });
}

/** Sends one command to docker_manager.py (used by the one-time upgrade scripts). */
export function runDockerManager(
  request: Record<string, unknown>,
  onLog?: (line: string) => Promise<void> | void,
): Promise<void> {
  return runDockerManagerCommand(request, onLog);
}

function runDockerManagerCommand(
  request: Record<string, unknown>,
  onLog?: (line: string) => Promise<void> | void,
): Promise<void> {
  const action = String(request.command);
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getDockerManagerScriptPath();
    const payload = JSON.stringify(request);

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.compose, (ms) =>
      rejectP(
        new DeployError(
          `Docker container action timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let buffer = "";
    let stderrBuffer = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: DockerManagerLine;
        try {
          parsed = JSON.parse(trimmed) as DockerManagerLine;
        } catch {
          if (onLog) void onLog(trimmed);
          continue;
        }

        if (parsed.error) {
          rejectP(new DeployError(parsed.error, parsed.code ?? "DOCKER_ACTION_ERROR", 422));
          return;
        }

        if (parsed.log && onLog) {
          void onLog(parsed.log);
        }

        if (parsed.done) {
          resolveP();
        }
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const errDetails = stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : "";
        rejectP(
          new DeployError(
            `docker_manager.py (${action}) exited with code ${code}${errDetails}`,
            "DOCKER_NONZERO_EXIT",
            422,
          ),
        );
      } else {
        resolveP();
      }
    });

    child.on("error", (err) => {
      rejectP(
        new DeployError(
          `Failed to spawn docker_manager.py: ${err.message}`,
          "DOCKER_MANAGER_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

export function runDockerStatus(
  projectDir: string,
  projectType: string,
): Promise<{ containerStatus: string; containerId: string | null }> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getDockerManagerScriptPath();
    const payload = JSON.stringify({ command: "status", projectDir, projectType });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.status, (ms) =>
      rejectP(
        new DeployError(
          `Docker status check timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", () => {
      const raw = stdout.trim();
      if (!raw) {
        rejectP(
          new DeployError(
            `docker_manager.py (status) produced no output (stderr: ${stderr.trim()})`,
            "DOCKER_STATUS_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: DockerManagerLine;
      try {
        parsed = JSON.parse(raw) as DockerManagerLine;
      } catch {
        rejectP(
          new DeployError(
            `docker_manager.py (status) returned invalid JSON: ${raw}`,
            "DOCKER_STATUS_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed.error) {
        rejectP(new DeployError(parsed.error, parsed.code ?? "DOCKER_STATUS_ERROR", 422));
        return;
      }

      resolveP({
        containerStatus: parsed.containerStatus ?? "unknown",
        containerId: parsed.containerId ?? null,
      });
    });

    child.on("error", (err) => {
      rejectP(
        new DeployError(
          `Failed to spawn docker_manager.py: ${err.message}`,
          "DOCKER_MANAGER_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

export function runDockerLogs(
  projectDir: string,
  projectType: string,
  tail: number = 100,
): Promise<{ logs: string }> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getDockerManagerScriptPath();
    const payload = JSON.stringify({ command: "logs", projectDir, projectType, tail });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.logs, (ms) =>
      rejectP(
        new DeployError(
          `Docker logs fetch timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", () => {
      const raw = stdout.trim();
      if (!raw) {
        resolveP({ logs: stderr.trim() });
        return;
      }

      let parsed: DockerManagerLine;
      try {
        parsed = JSON.parse(raw) as DockerManagerLine;
      } catch {
        resolveP({ logs: raw });
        return;
      }

      if (parsed.error) {
        rejectP(new DeployError(parsed.error, parsed.code ?? "DOCKER_LOGS_ERROR", 422));
        return;
      }

      resolveP({ logs: parsed.logs ?? "" });
    });

    child.on("error", (err) => {
      rejectP(
        new DeployError(
          `Failed to spawn docker_manager.py: ${err.message}`,
          "DOCKER_MANAGER_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Service Layer
// ---------------------------------------------------------------------------

export class DeployService {
  constructor(private prisma: PrismaClient) {}

  async deploy(
    userId: string,
    projectId: string,
    body: DeployBody = {},
  ): Promise<{
    containerId: string;
    internalPort: number;
    deployedDomain: string;
    containerStatus: string;
  }> {
    const project = await this.findOwnedProject(userId, projectId);

    const projectDir = resolve(env.PROJECTS_DIR, projectId);
    if (!existsSync(projectDir)) {
      throw new DeployError(
        "Project workspace directory not found on disk. Connect repository first.",
        "PROJECT_DIR_NOT_FOUND",
        400,
      );
    }

    let imageName = `${env.NIXPACKS_IMAGE_PREFIX}-${projectId}`;
    let staticRoot: string | undefined;

    // F5.7 — redeploy without rebuilding: static/WordPress projects skip
    // Nixpacks entirely and use the fixed image(s) baked into their templates.
    if (project.type === "STATIC" || project.type === "REACT") {
      imageName = "nginx:alpine";
      if (project.buildCmd) {
        const staticOutputDir = resolve(projectDir, "deploy", "static-output");
        if (!existsSync(staticOutputDir)) {
          throw new DeployError(
            "This project has a build command but hasn't been built yet. Trigger a build first.",
            "STATIC_OUTPUT_MISSING",
            400,
          );
        }
        staticRoot = staticOutputDir;
      } else {
        staticRoot = projectDir;
      }
    }

    // F5.21 — same redeploy-without-rebuild treatment for no-build PHP
    // (no composer.json/buildCmd): bind-mount the project dir directly, no
    // Nixpacks image involved.
    if (project.type === "PHP" && !project.buildCmd) {
      imageName = env.PHP_FPM_IMAGE;
      staticRoot = projectDir;
    }

    // Fetch and decrypt project environment variables. Done before the status
    // flips to CREATING so an undecryptable secret fails the request cleanly
    // instead of leaving the project stuck mid-deploy.
    const envService = new EnvService(this.prisma);
    let envVars: Record<string, string>;
    try {
      envVars = await envService.getDecryptedMap(projectId);
    } catch (err) {
      if (err instanceof EnvError) {
        throw new DeployError(err.message, err.code, err.statusCode);
      }
      throw err;
    }

    // Update project status to CREATING / DEPLOYING
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: "CREATING" },
    });

    const result = await runDockerDeploy({
      projectId,
      projectName: project.name,
      projectDir,
      imageName,
      projectType: project.type,
      baseDomain: env.BASE_DOMAIN,
      memoryLimit: env.DEPLOY_MEMORY_LIMIT,
      portRangeStart: env.DEPLOY_PORT_RANGE_START,
      portRangeEnd: env.DEPLOY_PORT_RANGE_END,
      containerPort: project.port,
      domain: body.domain,
      staticRoot,
      phpFpmImage: env.PHP_FPM_IMAGE,
      envVars,
    });

    // Update Project database record
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        containerId: result.containerId,
        containerStatus: "running",
        internalPort: result.hostPort,
        deployedDomain: result.hostname,
        deployedAt: new Date(),
        status: "ACTIVE",
      },
    });

    return {
      containerId: updated.containerId ?? result.containerId,
      internalPort: updated.internalPort ?? result.hostPort,
      deployedDomain: updated.deployedDomain ?? result.hostname,
      containerStatus: updated.containerStatus ?? "running",
    };
  }

  async containerAction(
    userId: string,
    projectId: string,
    action: "start" | "stop" | "restart" | "remove",
  ): Promise<{ message: string; containerStatus: string }> {
    await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    if (!existsSync(projectDir)) {
      throw new DeployError(
        "Project workspace directory not found on disk.",
        "PROJECT_DIR_NOT_FOUND",
        400,
      );
    }

    await runDockerAction(action, projectDir);

    let nextContainerStatus = "unknown";
    let nextProjectStatus: "ACTIVE" | "STOPPED" = "ACTIVE";

    switch (action) {
      case "start":
      case "restart":
        nextContainerStatus = "running";
        nextProjectStatus = "ACTIVE";
        break;
      case "stop":
        nextContainerStatus = "exited";
        nextProjectStatus = "STOPPED";
        break;
      case "remove":
        nextContainerStatus = "removed";
        nextProjectStatus = "STOPPED";
        break;
    }

    if (action === "remove") {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          containerId: null,
          containerStatus: null,
          internalPort: null,
          deployedDomain: null,
          status: "STOPPED",
        },
      });
    } else {
      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          containerStatus: nextContainerStatus,
          status: nextProjectStatus,
        },
      });
    }

    return {
      message: `Container ${action} completed successfully`,
      containerStatus: nextContainerStatus,
    };
  }

  async getContainerStatus(
    userId: string,
    projectId: string,
  ): Promise<{ containerStatus: string; containerId: string | null }> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    if (!existsSync(projectDir)) {
      return { containerStatus: "not_found", containerId: null };
    }

    const status = await runDockerStatus(projectDir, project.type);

    // Sync database cache
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        containerStatus: status.containerStatus,
        ...(status.containerId ? { containerId: status.containerId } : {}),
      },
    });

    return status;
  }

  async getContainerLogs(
    userId: string,
    projectId: string,
    tail: number = 100,
  ): Promise<{ logs: string }> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    if (!existsSync(projectDir)) {
      throw new DeployError(
        "Project workspace directory not found on disk.",
        "PROJECT_DIR_NOT_FOUND",
        400,
      );
    }

    return runDockerLogs(projectDir, project.type, tail);
  }

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        type: true,
        userId: true,
        port: true,
        gitUrl: true,
        buildCmd: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new DeployError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new DeployError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }
}
