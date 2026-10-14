import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Deployment, ProjectType } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { runDockerDeploy, runDockerStatus } from "../deploy/service.js";
import { runGitManager } from "../git/service.js";
import { isFatalGitSyncError } from "./gitSyncPolicy.js";
import { EnvService } from "../env/service.js";
import { getGitHubInstallationToken } from "../github/service.js";
import { CleanupService } from "../cleanup/service.js";
import { getIO } from "../../plugins/socket.js";
import type { BuildJobData, DeploymentListQuery, TriggerBuildBody } from "./schema.js";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BuildError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

// ---------------------------------------------------------------------------
// Queue name constant
// ---------------------------------------------------------------------------

export const BUILD_QUEUE_NAME = "build-queue";

// ---------------------------------------------------------------------------
// Helper — locate build_manager.py, same strategy as git_manager.py
// ---------------------------------------------------------------------------

function getBuildManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/build_manager.py"),
    resolve(currentDir, "../../../../system/python/build_manager.py"),
    resolve(process.cwd(), "../../system/python/build_manager.py"),
    resolve(process.cwd(), "system/python/build_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/build_manager.py");
}

// ---------------------------------------------------------------------------
// Helper — run build_manager.py for a single command (plan / build)
// Streams stdout line-by-line so log lines can be appended progressively.
// ---------------------------------------------------------------------------

interface BuildManagerLine {
  log?: string;
  done?: boolean;
  imageName?: string;
  framework?: string;
  buildCmd?: string;
  error?: string;
  code?: string;
}

interface PlanResult {
  framework: string;
  buildCmd: string | null;
  startCmd: string | null;
  detectedType: string | null;
}

function runBuildPlan(
  projectDir: string,
  envVars?: Record<string, string>,
): Promise<PlanResult> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getBuildManagerScriptPath();
    const payload = JSON.stringify({ command: "plan", projectDir, envVars });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", () => {
      const raw = stdout.trim();
      if (!raw) {
        rejectP(new BuildError(
          `build_manager.py (plan) produced no output (stderr: ${stderr.trim()})`,
          "BUILD_MANAGER_NO_OUTPUT", 500,
        ));
        return;
      }

      let parsed: BuildManagerLine & { startCmd?: string; detectedType?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectP(new BuildError(
          `build_manager.py (plan) returned invalid JSON: ${raw}`,
          "BUILD_MANAGER_INVALID_JSON", 500,
        ));
        return;
      }

      if (parsed.error) {
        rejectP(new BuildError(parsed.error, parsed.code ?? "BUILD_PLAN_ERROR", 422));
        return;
      }

      resolveP({
        framework: parsed.framework ?? "unknown",
        buildCmd: parsed.buildCmd ?? null,
        startCmd: parsed.startCmd ?? null,
        detectedType: parsed.detectedType ?? null,
      });
    });

    child.on("error", (err) => {
      rejectP(new BuildError(
        `Failed to spawn build_manager.py: ${err.message}`,
        "BUILD_MANAGER_SPAWN_ERROR", 500,
      ));
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

interface BuildImageOptions {
  projectDir: string;
  imageName: string;
  buildCmd: string | null;
  startCmd?: string | null;
  cacheKey?: string | null;
  envVars?: Record<string, string>;
}

function runBuildImage(
  options: BuildImageOptions,
  onLog: (line: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getBuildManagerScriptPath();
    const payload = JSON.stringify({
      command: "build",
      projectDir: options.projectDir,
      imageName: options.imageName,
      buildCmd: options.buildCmd,
      startCmd: options.startCmd,
      cacheKey: options.cacheKey,
      envVars: options.envVars,
    });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderrBuffer = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Keep last incomplete line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: BuildManagerLine;
        try {
          parsed = JSON.parse(trimmed) as BuildManagerLine;
        } catch {
          // Treat non-JSON output as plain log line
          void onLog(trimmed);
          continue;
        }

        if (parsed.error) {
          rejectP(new BuildError(parsed.error, parsed.code ?? "BUILD_ERROR", 422));
          return;
        }

        if (parsed.log) {
          void onLog(parsed.log);
        }

        if (parsed.done) {
          resolveP();
        }
      }
    });

    child.on("close", (code) => {
      // Flush remaining buffer
      if (buffer.trim()) void onLog(buffer.trim());
      if (code !== 0) {
        const errDetails = stderrBuffer.trim() ? `:\n${stderrBuffer.trim()}` : "";
        rejectP(new BuildError(
          `build_manager.py (build) exited with code ${code}${errDetails}`,
          "BUILD_NONZERO_EXIT", 422,
        ));
      } else {
        resolveP();
      }
    });

    child.on("error", (err) => {
      rejectP(new BuildError(
        `Failed to spawn build_manager.py: ${err.message}`,
        "BUILD_MANAGER_SPAWN_ERROR", 500,
      ));
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

interface ExtractStaticOutputResult {
  staticOutputDir: string;
}

// F5.7 — pull a STATIC/REACT project's built output out of a throwaway
// Nixpacks image (never deployed itself; only its output dir is served by
// the fixed nginx:alpine image).
function runExtractStaticOutput(
  options: { projectDir: string; imageName: string },
  onLog: (line: string) => Promise<void>,
): Promise<ExtractStaticOutputResult> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getBuildManagerScriptPath();
    const payload = JSON.stringify({
      command: "extract-static-output",
      projectDir: options.projectDir,
      imageName: options.imageName,
    });

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderrBuffer = "";
    let result: ExtractStaticOutputResult | null = null;

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

        let parsed: BuildManagerLine & { success?: boolean; staticOutputDir?: string };
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          void onLog(trimmed);
          continue;
        }

        if (parsed.error) {
          rejectP(new BuildError(parsed.error, parsed.code ?? "STATIC_EXTRACT_ERROR", 422));
          return;
        }
        if (parsed.log) void onLog(parsed.log);
        if (parsed.success && parsed.staticOutputDir) {
          result = { staticOutputDir: parsed.staticOutputDir };
        }
      }
    });

    child.on("close", (code) => {
      if (buffer.trim()) void onLog(buffer.trim());
      if (code !== 0) {
        const errDetails = stderrBuffer.trim() ? `:\n${stderrBuffer.trim()}` : "";
        rejectP(new BuildError(
          `build_manager.py (extract-static-output) exited with code ${code}${errDetails}`,
          "STATIC_EXTRACT_NONZERO_EXIT", 422,
        ));
      } else if (result) {
        resolveP(result);
      } else {
        rejectP(new BuildError(
          "build_manager.py (extract-static-output) finished without returning an output directory",
          "STATIC_EXTRACT_NO_RESULT", 500,
        ));
      }
    });

    child.on("error", (err) => {
      rejectP(new BuildError(
        `Failed to spawn build_manager.py: ${err.message}`,
        "BUILD_MANAGER_SPAWN_ERROR", 500,
      ));
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// BullMQ job processor — runs the actual build
// ---------------------------------------------------------------------------

export function createBuildProcessor(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
) {
  return async (job: { id?: string; name: string; data: BuildJobData }): Promise<void> => {
    const { deploymentId, projectId, projectDir, imageName, buildCmd } = job.data;
    const startedAt = Date.now();

    // Maintain an in-memory log accumulator to prevent async race conditions
    let accumulatedLogs = "";
    let isPersisting = false;
    let pendingPersist = false;
    let saveTimeout: NodeJS.Timeout | null = null;

    const flushLogsToDb = async () => {
      if (isPersisting) {
        pendingPersist = true;
        return;
      }
      isPersisting = true;
      try {
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: { buildLogs: accumulatedLogs },
        });
      } catch (err) {
        logger.error({ deploymentId, err }, "Failed to update buildLogs in DB");
      } finally {
        isPersisting = false;
        if (pendingPersist) {
          pendingPersist = false;
          void flushLogsToDb();
        }
      }
    };

    const appendLog = async (line: string) => {
      accumulatedLogs += line + "\n";

      // Emit real-time log immediately via Socket.io
      try {
        getIO()
          .to(`deployment:${deploymentId}`)
          .emit("log:build", { line, ts: Date.now() });
      } catch {
        // Socket.io may not be initialised in test environments — safe to ignore
      }

      // Debounced persist to avoid DB write thrashing during rapid build output
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        void flushLogsToDb();
      }, 200);
    };

    try {
      // Mark as BUILDING
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "BUILDING" },
      });

      await appendLog("[vexlyx] Starting build…");
      await appendLog(`[vexlyx] Project directory: ${projectDir}`);
      await appendLog(`[vexlyx] Image name: ${imageName}`);

      // Fetch project details
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          name: true,
          type: true,
          port: true,
          startCmd: true,
          gitUrl: true,
          branch: true,
          sshPrivateKeyPath: true,
          githubConnectionStatus: true,
          githubInstallation: { select: { installationId: true, status: true } },
        },
      });

      if (!project) {
        throw new Error("Project not found during build phase");
      }

      // If project has a connected git repository, sync latest commits
      if (project.gitUrl) {
        await appendLog(`[vexlyx] Syncing latest git commits (${project.branch})…`);
        try {
          if (
            project.githubInstallation &&
            (project.githubConnectionStatus !== "CONNECTED" || project.githubInstallation.status !== "CONNECTED")
          ) {
            throw new Error("The GitHub connection is inactive. Reconnect it before deploying.");
          }
          const accessToken = project.githubInstallation
            ? await getGitHubInstallationToken(prisma, project.githubInstallation.installationId)
            : undefined;
          await runGitManager({
            command: "clone",
            projectId,
            gitUrl: project.gitUrl,
            branch: project.branch,
            projectsDir: resolve(env.PROJECTS_DIR),
            sshPrivateKeyPath: project.sshPrivateKeyPath ?? undefined,
            accessToken,
          });
          await appendLog("[vexlyx] Git workspace up-to-date ✓");
        } catch (gitErr) {
          const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
          await appendLog(`[vexlyx:warn] Git sync notice: ${msg}`);
          if (isFatalGitSyncError(gitErr, Boolean(project.githubInstallation))) throw gitErr;
        }
      }

      // Fetch and decrypt project environment variables early
      const envService = new EnvService(prisma);
      const envVars = await envService.getDecryptedMap(projectId);

      // Phase 1 — detect framework
      await appendLog("[vexlyx] Detecting framework with nixpacks plan…");
      let planResult: PlanResult;
      try {
        planResult = await runBuildPlan(projectDir, envVars);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await appendLog(`[vexlyx:error] Framework detection failed: ${msg}`);
        throw err;
      }

      const displayFramework =
        planResult.framework === "dockerfile" || planResult.framework === "docker"
          ? "Custom Dockerfile"
          : planResult.framework === "nextjs"
          ? "Next.js"
          : planResult.framework === "django"
          ? "Django"
          : planResult.framework === "flask"
          ? "Flask"
          : planResult.framework === "fastapi"
          ? "FastAPI"
          : planResult.framework === "python"
          ? "Python"
          : planResult.framework === "react" || planResult.framework === "react-vite"
          ? "React (Vite)"
          : planResult.framework === "vue"
          ? "Vue (Vite)"
          : planResult.framework === "svelte"
          ? "Svelte (Vite)"
          : planResult.framework === "vite"
          ? "Vite (Static)"
          : planResult.framework === "gulp"
          ? "Gulp (Static)"
          : planResult.framework === "webpack"
          ? "Webpack (Static)"
          : planResult.framework === "wordpress"
          ? "WordPress"
          : planResult.framework === "laravel"
          ? "Laravel (PHP)"
          : planResult.framework === "symfony"
          ? "Symfony (PHP)"
          : planResult.framework === "php"
          ? "PHP"
          : planResult.framework === "static"
          ? "Static Site"
          : planResult.framework.charAt(0).toUpperCase() + planResult.framework.slice(1);
      await appendLog(`[vexlyx] Detected framework: ${displayFramework}`);

      // Auto-align project type if framework is detected and differs from current setting
      let effectiveProjectType = project.type;
      if (
        planResult.detectedType &&
        project.type !== planResult.detectedType
      ) {
        await prisma.project.update({
          where: { id: projectId },
          data: { type: planResult.detectedType as ProjectType },
        });
        effectiveProjectType = planResult.detectedType as ProjectType;
        await appendLog(
          `[vexlyx] Project type auto-aligned from ${project.type} to ${displayFramework} (${planResult.detectedType})`,
        );
      }

      // Use provided buildCmd override, then plan's detected cmd, then null
      const effectiveBuildCmd = buildCmd ?? planResult.buildCmd;
      if (effectiveBuildCmd) {
        await appendLog(`[vexlyx] Build command: ${effectiveBuildCmd}`);
      }

      // F5.7 — no-build deploy path for static sites with no buildCmd, and
      // for WordPress (which always uses the fixed official image pair).
      const isStaticNoBuild =
        (effectiveProjectType === "STATIC" || effectiveProjectType === "REACT") && !effectiveBuildCmd;
      const isWordPress = effectiveProjectType === "WORDPRESS";
      // F5.21 — no-build deploy path for PHP with no composer.json/buildCmd,
      // generalizing the WordPress two-container (PHP-FPM + nginx) shape.
      const isPhpNoBuild = effectiveProjectType === "PHP" && !effectiveBuildCmd;

      let deployImageName = imageName;
      let staticRoot: string | undefined;

      // F5.15 — capture the image ID this project's tag currently points to
      // *before* the rebuild retags it, so the superseded image can be
      // removed after the new one is confirmed healthy. Null on first
      // deploy (tag doesn't exist yet). Only relevant for the Nixpacks
      // branch below — static-no-build/WordPress deploy fixed public images
      // shared across projects, which must never be pruned per-project.
      const cleanupService = new CleanupService(prisma, logger);
      let oldImageId: string | null = null;

      if (isStaticNoBuild) {
        await appendLog("[vexlyx] Static site with no build command — skipping Nixpacks build");
        deployImageName = "nginx:alpine";
        staticRoot = projectDir;
      } else if (isWordPress) {
        await appendLog("[vexlyx] WordPress project — skipping Nixpacks build, using official WordPress image");
      } else if (isPhpNoBuild) {
        await appendLog("[vexlyx] PHP project with no build command — skipping Nixpacks build");
        deployImageName = env.PHP_FPM_IMAGE;
        staticRoot = projectDir;
      } else {
        const cleanupSettings = await cleanupService.getSettings().catch(() => null);
        if (cleanupSettings?.pruneAfterRedeploy) {
          oldImageId = await cleanupService.getImageId(imageName).catch(() => null);
        }

        // Phase 2 — build Docker image with caching and build-time env vars
        await appendLog("[vexlyx] Building Docker image with Nixpacks…");
        await runBuildImage(
          {
            projectDir,
            imageName,
            buildCmd: effectiveBuildCmd,
            startCmd: project.startCmd ?? planResult.startCmd,
            cacheKey: `vexlyx-${projectId}`,
            envVars,
          },
          appendLog,
        );
        await appendLog("[vexlyx] Build complete ✓");

        if (
          (effectiveProjectType === "STATIC" || effectiveProjectType === "REACT") &&
          effectiveBuildCmd
        ) {
          await appendLog("[vexlyx] Extracting static build output…");
          const extractResult = await runExtractStaticOutput({ projectDir, imageName }, appendLog);
          staticRoot = extractResult.staticOutputDir;
          deployImageName = "nginx:alpine";
          await appendLog("[vexlyx] Static build output extracted ✓");
        }
      }

      // Phase 3 — Deploy container via Docker Compose
      await appendLog("[vexlyx] Deploying container via Docker Compose…");
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "DEPLOYING" },
      });

      const deployResult = await runDockerDeploy(
        {
          projectId,
          projectName: project.name,
          projectDir,
          imageName: deployImageName,
          projectType: effectiveProjectType,
          baseDomain: env.BASE_DOMAIN,
          memoryLimit: env.DEPLOY_MEMORY_LIMIT,
          portRangeStart: env.DEPLOY_PORT_RANGE_START,
          portRangeEnd: env.DEPLOY_PORT_RANGE_END,
          containerPort: project.port,
          staticRoot,
          phpFpmImage: env.PHP_FPM_IMAGE,
          envVars,
        },
        appendLog,
      );

      await appendLog(
        `[vexlyx] Container running on port ${deployResult.hostPort} (${deployResult.hostname}) ✓`,
      );

      // F5.15 — once the new container is confirmed healthy (running after a
      // short grace period), remove the image the tag pointed to before this
      // rebuild. Best-effort: never blocks or fails the deployment.
      if (oldImageId) {
        const imageIdToPrune = oldImageId;
        void (async () => {
          try {
            const composeDir = resolve(projectDir, "deploy");
            let healthy = false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              await new Promise((r) => setTimeout(r, 2000));
              const status = await runDockerStatus(composeDir, effectiveProjectType);
              if (status.containerStatus === "running") {
                healthy = true;
                break;
              }
            }
            if (healthy) {
              await cleanupService.pruneAfterRedeploy(imageIdToPrune);
            }
          } catch (cleanupErr) {
            logger.warn({ deploymentId, cleanupErr }, "Post-redeploy image cleanup failed");
          }
        })();
      }

      // Ensure all logs are flushed
      if (saveTimeout) clearTimeout(saveTimeout);

      const duration = Math.round((Date.now() - startedAt) / 1000);

      // Update project with container details
      await prisma.project.update({
        where: { id: projectId },
        data: {
          containerId: deployResult.containerId,
          containerStatus: "running",
          internalPort: deployResult.hostPort,
          deployedDomain: deployResult.hostname,
          deployedAt: new Date(),
          status: "ACTIVE",
        },
      });

      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "RUNNING",
          duration,
          buildLogs: accumulatedLogs,
        },
      });

      logger.info({ deploymentId, duration, hostPort: deployResult.hostPort }, "Build and deploy job completed");
    } catch (err) {
      if (saveTimeout) clearTimeout(saveTimeout);
      const msg = err instanceof Error ? err.message : String(err);

      accumulatedLogs += `[vexlyx:error] ${msg}\n`;

      try {
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: "FAILED",
            duration: Math.round((Date.now() - startedAt) / 1000),
            buildLogs: accumulatedLogs,
          },
        });
      } catch (updateErr) {
        logger.error({ deploymentId, updateErr }, "Failed to mark deployment as FAILED");
      }

      logger.error({ deploymentId, err }, "Build job failed");
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BuildService {
  constructor(private prisma: PrismaClient) {}

  async triggerBuild(
    userId: string,
    projectId: string,
    body: TriggerBuildBody,
    enqueueJob: (data: BuildJobData) => Promise<void>,
  ): Promise<Deployment> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);
    const hasLocalFiles = existsSync(projectDir) && readdirSync(projectDir).length > 0;

    if (!project.gitUrl && !hasLocalFiles) {
      throw new BuildError(
        "This project has no source yet. Connect a git repository, upload files via the File Manager, or install WordPress before deploying.",
        "PROJECT_NOT_CLONED",
        400,
      );
    }

    if (!existsSync(projectDir)) {
      throw new BuildError(
        "Project source directory not found on disk. Connect a git repository, upload files via the File Manager, or install WordPress before deploying.",
        "PROJECT_DIR_MISSING",
        400,
      );
    }

    const imageName = `${env.NIXPACKS_IMAGE_PREFIX}-${projectId}`;

    const deployment = await this.prisma.deployment.create({
      data: {
        projectId,
        status: "QUEUED",
      },
    });

    const effectiveBuildCmd = body.buildCmd ?? project.buildCmd ?? null;

    await enqueueJob({
      deploymentId: deployment.id,
      projectId,
      userId,
      projectDir,
      imageName,
      buildCmd: effectiveBuildCmd,
    });

    return this.toDeploymentShape(deployment);
  }

  async getDeployment(
    userId: string,
    projectId: string,
    deploymentId: string,
  ): Promise<Deployment> {
    await this.findOwnedProject(userId, projectId);

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment || deployment.projectId !== projectId) {
      throw new BuildError("Deployment not found", "DEPLOYMENT_NOT_FOUND", 404);
    }

    return this.toDeploymentShape(deployment);
  }

  async listDeployments(
    userId: string,
    projectId: string,
    query: DeploymentListQuery,
  ): Promise<{ deployments: Deployment[]; total: number }> {
    await this.findOwnedProject(userId, projectId);

    const skip = (query.page - 1) * query.limit;

    const [deployments, total] = await this.prisma.$transaction([
      this.prisma.deployment.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
      }),
      this.prisma.deployment.count({ where: { projectId } }),
    ]);

    return {
      deployments: deployments.map((d) => this.toDeploymentShape(d)),
      total,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private toDeploymentShape(d: {
    id: string;
    status: string;
    commitHash: string | null;
    commitMsg: string | null;
    buildLogs: string | null;
    duration: number | null;
    projectId: string;
    createdAt: Date;
    updatedAt: Date;
  }): Deployment {
    return {
      id: d.id,
      status: d.status as Deployment["status"],
      commitHash: d.commitHash,
      commitMsg: d.commitMsg,
      buildLogs: d.buildLogs,
      duration: d.duration,
      projectId: d.projectId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        gitUrl: true,
        buildCmd: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new BuildError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new BuildError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }
}
