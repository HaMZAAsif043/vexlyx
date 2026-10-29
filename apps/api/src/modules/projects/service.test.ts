import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectRepoSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
} from "@vexlyx/shared";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLogService } from "../audit-log/service.js";

vi.mock("../../config/env.js", () => ({
  env: { PROJECTS_DIR: "/tmp/vexlyx-projects" },
}));
vi.mock("../../utils/quota.js", () => ({
  assertUnderQuota: vi.fn(),
  notifyQuotaThreshold: vi.fn(),
}));
vi.mock("../deploy/service.js", () => ({ runDockerAction: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));
vi.mock("node:fs/promises", () => ({ default: { rm: vi.fn() } }));
vi.mock("../domains/service.js", () => ({ removeTraefikRouteFile: vi.fn() }));
import { ProjectService } from "./service.js";
import { removeTraefikRouteFile } from "../domains/service.js";

describe("project Git URL policy", () => {
  it.each([
    "file:///private/repository",
    "http://169.254.169.254/repo",
    "https://example.com/team/repo",
    "ssh://internal/team/repo",
    "git://github.com/team/repo",
    "https://github.com:8080/team/repo",
    "https://github.com@localhost/team/repo",
    "https://github.com.evil.example/team/repo",
    "https://github.com/team/repo\n",
    "https://github.com\\@localhost/team/repo",
  ])("rejects an unsafe URL through every schema: %s", (gitUrl) => {
    expect(
      CreateProjectSchema.safeParse({ name: "test", type: "NODEJS", gitUrl })
        .success,
    ).toBe(false);
    expect(UpdateProjectSchema.safeParse({ gitUrl }).success).toBe(false);
    expect(ConnectRepoSchema.safeParse({ gitUrl }).success).toBe(false);
  });

  it.each([
    "https://github.com/team/repo.git",
    "https://gitlab.com/team/group/repo",
    "git@bitbucket.org:team/repo.git",
  ])("accepts supported repositories: %s", (gitUrl) => {
    expect(
      CreateProjectSchema.safeParse({ name: "test", type: "NODEJS", gitUrl })
        .success,
    ).toBe(true);
    expect(UpdateProjectSchema.safeParse({ gitUrl }).success).toBe(true);
    expect(ConnectRepoSchema.safeParse({ gitUrl }).success).toBe(true);
  });

  it("allows projects without a repository", () => {
    expect(
      CreateProjectSchema.safeParse({ name: "test", type: "STATIC" }).success,
    ).toBe(true);
    expect(UpdateProjectSchema.safeParse({ gitUrl: "" }).success).toBe(true);
  });
});

describe("project repository changes", () => {
  const project = {
    id: "p1",
    userId: "u1",
    deletedAt: null,
    gitUrl: "https://github.com/team/old",
  };
  const prisma = {
    project: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const service = new ProjectService(
    prisma as unknown as PrismaClient,
    {} as AuditLogService,
    {} as FastifyBaseLogger,
  );
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.project.findUnique.mockResolvedValue(project);
    prisma.project.findUniqueOrThrow.mockResolvedValue(project);
    prisma.project.update.mockResolvedValue(project);
    prisma.project.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each(["https://gitlab.com/team/new", ""])(
    "clears GitHub linkage when the repository changes: %s",
    async (gitUrl) => {
      await service.update("u1", "p1", { gitUrl });
      expect(prisma.project.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gitUrl: gitUrl || null,
            githubInstallationId: null,
            githubRepoId: null,
            githubRepoFullName: null,
            githubConnectionStatus: null,
            githubDisconnectReason: null,
          }),
        }),
      );
    },
  );

  it("writes only if the stored repository is still the one the decision was based on", async () => {
    await service.update("u1", "p1", { gitUrl: "https://gitlab.com/team/new" });

    expect(prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1", gitUrl: project.gitUrl } }),
    );
  });

  it("rejects the update when another request changed the repository meanwhile", async () => {
    prisma.project.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.update("u1", "p1", { gitUrl: "https://gitlab.com/team/new" }),
    ).rejects.toMatchObject({ code: "PROJECT_CONFLICT", statusCode: 409 });
    expect(prisma.project.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("preserves linkage when the repository is unchanged", async () => {
    await service.update("u1", "p1", { gitUrl: project.gitUrl });
    expect(prisma.project.updateMany.mock.calls[0]![0].data).not.toHaveProperty(
      "githubInstallationId",
    );
  });

  it("updates without a repository guard when the URL is not part of the change", async () => {
    await service.update("u1", "p1", { buildCmd: "pnpm build" });

    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1" } }),
    );
  });

  it("rejects another owner's update before writing", async () => {
    await expect(
      service.update("other", "p1", { gitUrl: "https://github.com/team/new" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.project.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe("project deletion", () => {
  const project = {
    id: "p1",
    userId: "u1",
    name: "app",
    type: "NODEJS",
    deletedAt: null,
  };
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    scheduledTask: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    domain: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new ProjectService(
    prisma as unknown as PrismaClient,
    auditLog as unknown as AuditLogService,
    { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.project.findUnique.mockResolvedValue(project);
    prisma.project.update.mockResolvedValue(project);
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    prisma.domain.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
    prisma.domain.updateMany.mockResolvedValue({ count: 2 });
  });

  it("removes the route files and detaches the domains before the containers go away", async () => {
    await service.softDelete("u1", "p1");

    expect(removeTraefikRouteFile).toHaveBeenCalledWith("d1", expect.anything());
    expect(removeTraefikRouteFile).toHaveBeenCalledWith("d2", expect.anything());
    expect(prisma.domain.updateMany).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      data: { projectId: null },
    });
  });

  it("keeps the domain rows when the project has no domains", async () => {
    prisma.domain.findMany.mockResolvedValue([]);

    await service.softDelete("u1", "p1");

    expect(prisma.domain.updateMany).not.toHaveBeenCalled();
    expect(removeTraefikRouteFile).not.toHaveBeenCalled();
  });
});
