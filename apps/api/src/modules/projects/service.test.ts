import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectRepoSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
} from "@vexlyx/shared";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLogService } from "../audit-log/service.js";

vi.mock("../../config/env.js", () => ({ env: {} }));
vi.mock("../../utils/quota.js", () => ({
  assertUnderQuota: vi.fn(),
  notifyQuotaThreshold: vi.fn(),
}));
vi.mock("../deploy/service.js", () => ({ runDockerAction: vi.fn() }));
import { ProjectService } from "./service.js";

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

describe("project build overrides (F5.34)", () => {
  const stored = {
    id: "p1",
    userId: "u1",
    deletedAt: null,
    gitUrl: null,
    installCmd: null,
    buildCmd: null,
    startCmd: null,
    port: null,
  };
  const prisma = {
    project: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new ProjectService(
    prisma as unknown as PrismaClient,
    auditLog as unknown as AuditLogService,
    {} as FastifyBaseLogger,
  );

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.project.findUnique.mockResolvedValue(stored);
    prisma.project.findUniqueOrThrow.mockResolvedValue(stored);
    prisma.project.create.mockResolvedValue(stored);
    prisma.project.update.mockResolvedValue(stored);
    prisma.project.updateMany.mockResolvedValue({ count: 1 });
  });

  /** The `data` object of the single prisma.project.update call. */
  function writtenData(): Record<string, unknown> {
    return prisma.project.update.mock.calls[0]![0].data;
  }

  it("accepts an install command on create and on update", () => {
    expect(
      CreateProjectSchema.safeParse({
        name: "ideact",
        type: "NEXTJS",
        installCmd: "pnpm install --frozen-lockfile",
      }).success,
    ).toBe(true);
    expect(
      UpdateProjectSchema.safeParse({ installCmd: "pnpm install" }).success,
    ).toBe(true);
  });

  it("rejects an install command longer than the limit the other commands use", () => {
    const tooLong = "x".repeat(501);
    expect(
      UpdateProjectSchema.safeParse({ installCmd: tooLong }).success,
    ).toBe(false);
    expect(
      CreateProjectSchema.safeParse({
        name: "ideact",
        type: "NEXTJS",
        installCmd: tooLong,
      }).success,
    ).toBe(false);
  });

  it("writes every override the request sent", async () => {
    await service.update("u1", "p1", {
      installCmd: "pnpm install",
      buildCmd: "pnpm run build",
      startCmd: "pnpm start",
      port: 3000,
    });

    expect(writtenData()).toMatchObject({
      installCmd: "pnpm install",
      buildCmd: "pnpm run build",
      startCmd: "pnpm start",
      port: 3000,
    });
  });

  it("stores null for an override the user cleared, so detection takes over", async () => {
    await service.update("u1", "p1", { installCmd: null, port: null });

    expect(writtenData()).toMatchObject({ installCmd: null, port: null });
  });

  it("leaves a command the request did not mention untouched", async () => {
    await service.update("u1", "p1", { installCmd: "pnpm install" });

    expect(writtenData()).not.toHaveProperty("buildCmd");
    expect(writtenData()).not.toHaveProperty("startCmd");
    expect(writtenData()).not.toHaveProperty("port");
  });

  it("reads the stored install command when a project is fetched", async () => {
    await service.getById("u1", "p1");

    expect(prisma.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ installCmd: true }),
      }),
    );
  });

  it("stores a create request's install command instead of dropping it", async () => {
    // The name is free: create() looks the project up by (userId, name) first.
    prisma.project.findUnique.mockResolvedValueOnce(null);

    await service.create("u1", {
      name: "ideact",
      type: "NEXTJS",
      branch: "main",
      installCmd: "pnpm install",
    } as never);

    expect(prisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ installCmd: "pnpm install" }),
      }),
    );
  });
});
