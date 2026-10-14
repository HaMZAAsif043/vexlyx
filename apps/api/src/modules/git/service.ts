import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { GitMetadata } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import type { ConnectRepoInput } from "./schema.js";
import type { ConnectGitHubRepositoryInput } from "@vexlyx/shared";
import type { GitHubService } from "../github/service.js";
import type { AuditLogService } from "../audit-log/service.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "../../utils/processWatchdog.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

// ---------------------------------------------------------------------------
// Helper — run the Python git_manager.py script
// ---------------------------------------------------------------------------

interface GitManagerPayload {
  command: "clone" | "generate_ssh_key";
  [key: string]: unknown;
}

interface GitManagerResult {
  success?: boolean;
  error?: string;
  code?: string;
  publicKey?: string;
  privateKeyPath?: string;
  path?: string;
  action?: string;
}

function getGitManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 5 levels up from apps/api/src/modules/git/ (service.ts -> git -> modules -> src -> api -> apps -> Vexlyx)
    resolve(currentDir, "../../../../../system/python/git_manager.py"),
    // 4 levels up if compiled directly under apps/api/dist/modules/git/
    resolve(currentDir, "../../../../system/python/git_manager.py"),
    // Relative to apps/api (when CWD is apps/api)
    resolve(process.cwd(), "../../system/python/git_manager.py"),
    // Relative to monorepo root (when CWD is root)
    resolve(process.cwd(), "system/python/git_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const fallback = candidates[0];
  if (fallback) {
    return fallback;
  }
  return resolve(process.cwd(), "system/python/git_manager.py");
}

export function runGitManager(payload: GitManagerPayload): Promise<GitManagerResult> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getGitManagerScriptPath();

    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.git, (ms) =>
      rejectP(
        new GitError(
          `Git manager timed out after ${ms / 1000}s`,
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

    child.on("close", (code) => {
      const raw = stdout.trim();
      if (!raw) {
        rejectP(
          new GitError(
            `git_manager.py produced no output (stderr: ${stderr.trim()})`,
            "GIT_MANAGER_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: GitManagerResult;
      try {
        parsed = JSON.parse(raw) as GitManagerResult;
      } catch {
        rejectP(
          new GitError(
            `git_manager.py returned invalid JSON: ${raw}`,
            "GIT_MANAGER_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (code !== 0 || parsed.error) {
        rejectP(
          new GitError(
            parsed.error ?? "git_manager.py exited with a non-zero code",
            parsed.code ?? "GIT_MANAGER_ERROR",
            422,
          ),
        );
        return;
      }

      resolveP(parsed);
    });

    child.on("error", (err) => {
      rejectP(
        new GitError(
          `Failed to spawn git_manager.py: ${err.message}`,
          "GIT_MANAGER_SPAWN_ERROR",
          500,
        ),
      );
    });

    // Write JSON payload to the script's stdin, then close to signal EOF.
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GitService {
  constructor(
    private prisma: PrismaClient,
    private github?: GitHubService,
    private auditLog?: AuditLogService,
  ) {}

  async getMetadata(userId: string, projectId: string): Promise<GitMetadata> {
    const project = await this.findOwnedProject(userId, projectId);

    return {
      gitUrl: project.gitUrl,
      branch: project.branch,
      sshPublicKey: project.sshPublicKey,
      webhookUrl: project.webhookSecret
        ? `${env.API_BASE_URL}/api/webhooks/github?projectId=${projectId}`
        : null,
      webhookSecret: project.webhookSecret,
      isPrivate: project.sshPublicKey !== null,
      githubInstallationId: project.githubInstallationId,
      githubRepoId: project.githubRepoId?.toString() ?? null,
      githubRepoFullName: project.githubRepoFullName,
      githubConnectionStatus: project.githubConnectionStatus,
      githubDisconnectReason: project.githubDisconnectReason,
    };
  }

  async connectRepo(
    userId: string,
    projectId: string,
    data: ConnectRepoInput,
  ): Promise<GitMetadata> {
    const project = await this.findOwnedProject(userId, projectId);

    // Generate a webhook secret on first connect (idempotent — reuse existing).
    const webhookSecret =
      project.webhookSecret ?? randomBytes(32).toString("hex");

    // Call git_manager.py to clone / pull.
    await runGitManager({
      command: "clone",
      projectId,
      gitUrl: data.gitUrl,
      branch: data.branch,
      projectsDir: resolve(env.PROJECTS_DIR),
      sshPrivateKeyPath: project.sshPrivateKeyPath ?? undefined,
    });

    // Persist updated git metadata.
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitUrl: data.gitUrl,
        branch: data.branch,
        webhookSecret,
        githubInstallationId: null,
        githubRepoId: null,
        githubRepoFullName: null,
        githubConnectionStatus: null,
        githubDisconnectReason: null,
      },
      select: {
        gitUrl: true,
        branch: true,
        sshPublicKey: true,
        webhookSecret: true,
      },
    });

    return {
      gitUrl: updated.gitUrl,
      branch: updated.branch,
      sshPublicKey: updated.sshPublicKey,
      webhookUrl: `${env.API_BASE_URL}/api/webhooks/github?projectId=${projectId}`,
      webhookSecret: updated.webhookSecret,
      isPrivate: updated.sshPublicKey !== null,
      githubInstallationId: null,
      githubRepoId: null,
      githubRepoFullName: null,
      githubConnectionStatus: null,
      githubDisconnectReason: null,
    };
  }

  async connectGitHubRepository(
    userId: string,
    projectId: string,
    data: ConnectGitHubRepositoryInput,
  ): Promise<GitMetadata> {
    if (!this.github) throw new GitError("GitHub integration is unavailable", "GITHUB_UNAVAILABLE", 500);
    await this.findOwnedProject(userId, projectId);
    const installation = await this.github.getOwnedInstallationRecord(userId, data.installationId);
    const repository = await this.github.findRepository(installation.installationId, data.repositoryId);
    if (repository.archived) throw new GitError("Archived repositories cannot be connected", "GITHUB_REPOSITORY_ARCHIVED", 422);
    const branches = await this.github.listBranches(userId, data.installationId, data.repositoryId);
    if (!branches.some((branch) => branch.name === data.branch)) {
      throw new GitError("The selected branch does not exist", "GITHUB_BRANCH_NOT_FOUND", 404);
    }
    const token = await this.github.getInstallationToken(installation.installationId);
    await runGitManager({
      command: "clone",
      projectId,
      gitUrl: repository.clone_url,
      branch: data.branch,
      projectsDir: resolve(env.PROJECTS_DIR),
      accessToken: token,
    });
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitUrl: repository.clone_url,
        branch: data.branch,
        webhookSecret: null,
        sshPublicKey: null,
        sshPrivateKeyPath: null,
        githubInstallationId: installation.id,
        githubRepoId: BigInt(repository.id),
        githubRepoFullName: repository.full_name,
        githubConnectionStatus: "CONNECTED",
        githubDisconnectReason: null,
      },
    });
    await this.auditLog?.log(userId, "github.project_connected", { type: "Project", id: projectId }, {
      after: {
        installationId: installation.installationId.toString(),
        repository: repository.full_name,
        branch: data.branch,
      },
    });
    return this.getMetadata(userId, projectId);
  }

  async disconnectGitHubRepository(userId: string, projectId: string): Promise<GitMetadata> {
    const project = await this.findOwnedProject(userId, projectId);
    if (!project.githubInstallationId) return this.getMetadata(userId, projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitUrl: null,
        githubInstallationId: null,
        githubRepoId: null,
        githubRepoFullName: null,
        githubConnectionStatus: null,
        githubDisconnectReason: null,
        webhookSecret: null,
      },
    });
    await this.auditLog?.log(userId, "github.project_disconnected", { type: "Project", id: projectId }, {
      before: { repository: project.githubRepoFullName },
    });
    return this.getMetadata(userId, projectId);
  }

  async rotateWebhookSecret(
    userId: string,
    projectId: string,
  ): Promise<{ webhookSecret: string; webhookUrl: string }> {
    await this.findOwnedProject(userId, projectId);

    const newSecret = randomBytes(32).toString("hex");
    await this.prisma.project.update({
      where: { id: projectId },
      data: { webhookSecret: newSecret },
    });

    return {
      webhookSecret: newSecret,
      webhookUrl: `${env.API_BASE_URL}/api/webhooks/github?projectId=${projectId}`,
    };
  }

  async generateSshKey(
    userId: string,
    projectId: string,
  ): Promise<{ publicKey: string }> {
    await this.findOwnedProject(userId, projectId);

    const result = await runGitManager({
      command: "generate_ssh_key",
      projectId,
      keysDir: resolve(env.SSH_KEYS_DIR),
    });

    if (!result.publicKey || !result.privateKeyPath) {
      throw new GitError(
        "git_manager.py did not return key data",
        "GIT_KEYGEN_INCOMPLETE",
        500,
      );
    }

    // Store public key in DB for display; store private key path for future git ops.
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        sshPublicKey: result.publicKey,
        sshPrivateKeyPath: result.privateKeyPath,
      },
    });

    return { publicKey: result.publicKey };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        gitUrl: true,
        branch: true,
        webhookSecret: true,
        sshPublicKey: true,
        sshPrivateKeyPath: true,
        githubInstallationId: true,
        githubRepoId: true,
        githubRepoFullName: true,
        githubConnectionStatus: true,
        githubDisconnectReason: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new GitError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new GitError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }
}
