import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { CreateProjectInput, UpdateProjectInput, ProjectListQuery } from "./schema.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import { env } from "../../config/env.js";
import { runDockerAction } from "../deploy/service.js";
import type { AuditLogService } from "../audit-log/service.js";
import { getScheduledTaskQueue, unscheduleTaskJob } from "../scheduled-tasks/scheduler.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProjectError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

// ---------------------------------------------------------------------------
// Select shape — excludes deletedAt from all public responses
// ---------------------------------------------------------------------------

const PROJECT_SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  gitUrl: true,
  branch: true,
  buildCmd: true,
  startCmd: true,
  port: true,
  userId: true,
  containerId: true,
  containerStatus: true,
  internalPort: true,
  deployedDomain: true,
  deployedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProjectService {
  constructor(
    private prisma: PrismaClient,
    private auditLog: AuditLogService,
    private logger: FastifyBaseLogger,
  ) {}

  // Stops/removes a project's Docker containers and deletes its workspace
  // directory. Soft-deleting a project previously left both running
  // forever — the DB row said DELETED but nothing ever tore down the
  // containers or files, and once a same-named project got created/renamed
  // in later, the old row was hard-deleted to free the name, leaving a
  // container pair with zero trace in the database (found live: two no-build
  // PHP projects both claiming the "app"/"web" Compose aliases on the shared
  // traefik-net, see docs/dev/no-build-php-hosting.md). Docker failures are
  // logged but don't block the delete -- a project stuck on a broken
  // container shouldn't become permanently undeletable.
  private async teardownWorkspace(projectId: string): Promise<void> {
    const projectDir = resolve(env.PROJECTS_DIR, projectId);
    if (!existsSync(projectDir)) return;

    try {
      await runDockerAction("remove", projectDir);
    } catch (err) {
      this.logger.error({ projectId, err }, "Failed to remove project containers during delete");
    }

    await fs.rm(projectDir, { recursive: true, force: true });
  }

  async list(userId: string, query: ProjectListQuery) {
    const { page, limit, type, status, search } = query;
    const skip = (page - 1) * limit;

    const where = {
      userId,
      // Exclude soft-deleted projects from all list results
      status: status ?? { not: "DELETED" as const },
      ...(type && { type }),
      ...(search && {
        name: { contains: search, mode: "insensitive" as const },
      }),
    };

    const [projects, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        select: PROJECT_SELECT,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      projects,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ...PROJECT_SELECT, deletedAt: true },
    });

    if (!project || project.deletedAt !== null) {
      throw new ProjectError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new ProjectError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    // Strip deletedAt before returning
    const { deletedAt: _deleted, ...publicProject } = project;
    return publicProject;
  }

  async create(userId: string, data: CreateProjectInput) {
    await assertUnderQuota(
      this.prisma,
      userId,
      "project",
      (message, code, statusCode) => new ProjectError(message, code, statusCode),
    );

    // Check for duplicate name within this user's projects
    const existing = await this.prisma.project.findUnique({
      where: { userId_name: { userId, name: data.name } },
      select: { id: true, status: true },
    });

    if (existing) {
      if (existing.status !== "DELETED") {
        throw new ProjectError(
          `A project named "${data.name}" already exists`,
          "PROJECT_NAME_EXISTS",
          409,
        );
      }

      // If an old soft-deleted project occupied this name, tear down its
      // containers/files (in case its own soft-delete never did, e.g. a
      // pre-existing project from before this cleanup existed) before
      // removing it to allow re-creation.
      await this.teardownWorkspace(existing.id);
      await this.prisma.project.delete({
        where: { id: existing.id },
      });
    }

    try {
      const project = await this.prisma.project.create({
        data: {
          userId,
          name: data.name,
          type: data.type,
          // Start as ACTIVE — build engine (F1.4) will manage CREATING→ACTIVE later
          status: "ACTIVE",
          gitUrl: data.gitUrl || null,
          branch: data.branch,
          buildCmd: data.buildCmd ?? null,
          startCmd: data.startCmd ?? null,
          port: data.port ?? null,
        },
        select: PROJECT_SELECT,
      });
      void notifyQuotaThreshold(this.prisma, userId, "project");

      await this.auditLog.log(userId, "project.created", { type: "Project", id: project.id }, {
        after: { name: project.name, type: project.type },
      });

      return project;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002"
      ) {
        throw new ProjectError(
          `A project named "${data.name}" already exists`,
          "PROJECT_NAME_EXISTS",
          409,
        );
      }
      throw err;
    }
  }

  async update(userId: string, projectId: string, data: UpdateProjectInput) {
    // Verify ownership first
    const project = await this.getById(userId, projectId);

    // If name is changing, check it won't collide with another project
    if (data.name) {
      const collision = await this.prisma.project.findUnique({
        where: { userId_name: { userId, name: data.name } },
        select: { id: true, status: true },
      });

      if (collision && collision.id !== projectId) {
        if (collision.status !== "DELETED") {
          throw new ProjectError(
            `A project named "${data.name}" already exists`,
            "PROJECT_NAME_EXISTS",
            409,
          );
        }
        // If colliding record was soft-deleted, tear down its
        // containers/files (see teardownWorkspace) before removing it.
        await this.teardownWorkspace(collision.id);
        await this.prisma.project.delete({
          where: { id: collision.id },
        });
      }
    }

    try {
      const updateData = {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.gitUrl !== undefined && { gitUrl: data.gitUrl || null }),
        ...(data.gitUrl !== undefined && (data.gitUrl || null) !== project.gitUrl && {
          githubInstallationId: null,
          githubRepoId: null,
          githubRepoFullName: null,
          githubConnectionStatus: null,
          githubDisconnectReason: null,
        }),
        ...(data.branch !== undefined && { branch: data.branch }),
        ...(data.buildCmd !== undefined && { buildCmd: data.buildCmd }),
        ...(data.startCmd !== undefined && { startCmd: data.startCmd }),
        ...(data.port !== undefined && { port: data.port }),
      };

      if (data.gitUrl !== undefined) {
        // The linkage decision above used the URL read earlier. Write only if the
        // stored URL is still that one, otherwise a concurrent repository change
        // (e.g. a GitHub connection) could be overwritten while keeping its
        // installation link.
        const { count } = await this.prisma.project.updateMany({
          where: { id: projectId, gitUrl: project.gitUrl },
          data: updateData,
        });
        if (count === 0) {
          throw new ProjectError(
            "The project's repository was changed by another request. Reload the project and try again.",
            "PROJECT_CONFLICT",
            409,
          );
        }
        return await this.prisma.project.findUniqueOrThrow({
          where: { id: projectId },
          select: PROJECT_SELECT,
        });
      }

      return await this.prisma.project.update({
        where: { id: projectId },
        data: updateData,
        select: PROJECT_SELECT,
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "P2002"
      ) {
        throw new ProjectError(
          `A project named "${data.name}" already exists`,
          "PROJECT_NAME_EXISTS",
          409,
        );
      }
      throw err;
    }
  }

  async softDelete(userId: string, projectId: string) {
    // Verify ownership
    const project = await this.getById(userId, projectId);

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
      },
    });

    // F5.28: stop this project's scheduled tasks before the workspace is torn
    // down, so no task keeps firing (and emailing its owner) against a removed
    // container.
    await this.disableScheduledTasks(projectId);

    await this.teardownWorkspace(projectId);

    await this.auditLog.log(userId, "project.deleted", { type: "Project", id: projectId }, {
      before: { name: project.name, type: project.type },
    });
  }

  /**
   * Disables every scheduled task of a project and disarms its BullMQ jobs.
   * The rows are disabled first: even if disarming fails (already logged), the
   * worker will not execute them and the next boot only re-arms enabled tasks.
   */
  private async disableScheduledTasks(projectId: string) {
    const tasks = await this.prisma.scheduledTask.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (tasks.length === 0) return;

    await this.prisma.scheduledTask.updateMany({
      where: { projectId },
      data: { enabled: false, nextRunAt: null },
    });

    const queue = getScheduledTaskQueue();
    if (!queue) return;
    for (const task of tasks) {
      try {
        await unscheduleTaskJob(queue, task.id, this.logger);
      } catch {
        // Already logged by unscheduleTaskJob; the rows are disabled above.
      }
    }
  }
}
