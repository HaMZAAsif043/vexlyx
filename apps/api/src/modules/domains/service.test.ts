import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";
import { UpdateDomainSchema } from "@vexlyx/shared";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
vi.mock("../../utils/quota.js", () => ({ assertUnderQuota: vi.fn(), notifyQuotaThreshold: vi.fn() }));
const { DomainService } = await import("./service.js");

function fixture(projectId: string | null = null, status = "ACTIVE") {
  const domain = {
    id: "d1",
    userId: "u1",
    hostname: "example.com",
    projectId,
    status,
    verificationToken: "keep-token",
    sslEnabled: true,
  };
  const certificate = { id: "c1", type: "CUSTOM", forceHttps: false };
  const project = {
    id: "p2",
    name: "Target",
    status: "RUNNING",
    port: 8080,
    internalPort: 8080,
  };
  const prisma = {
    domain: {
      findFirst: vi.fn().mockResolvedValue(domain),
      update: vi
        .fn()
        .mockImplementation(async ({ data }) => ({
          ...domain,
          ...data,
          certificate,
          project: data.projectId ? project : null,
        })),
    },
    project: { findFirst: vi.fn().mockResolvedValue(project) },
  };
  const audit = { log: vi.fn() };
  const service = new DomainService(
    prisma as unknown as PrismaClient,
    audit as unknown as AuditLogService,
  );
  const sync = vi
    .spyOn(service, "syncTraefikRouter")
    .mockImplementation(() => {});
  vi.spyOn(service, "getById").mockResolvedValue(domain as never);
  return { prisma, service, sync, audit, certificate };
}

describe("DomainService.update", () => {
  it("reports an existing domain before checking creation quota so it can still be attached", async () => {
    const prisma = {
      domain: { findUnique: vi.fn().mockResolvedValue({ id: "d1" }) },
    };
    const service = new DomainService(prisma as unknown as PrismaClient);
    await expect(
      service.create("u1", { hostname: "example.com", projectId: "p2" }),
    ).rejects.toMatchObject({ code: "DOMAIN_ALREADY_EXISTS", statusCode: 409 });
  });

  it.each([
    [null, "p2"],
    ["p1", "p2"],
    ["p1", null],
  ])(
    "assigns, moves, and unassigns (%s -> %s) without recreating the domain",
    async (before, after) => {
      const { service, prisma, sync, audit, certificate } = fixture(before);
      await service.update("u1", "d1", { projectId: after });
      expect(prisma.domain.findFirst).toHaveBeenCalledWith({
        where: { id: "d1", userId: "u1" },
      });
      expect(prisma.domain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "d1", userId: "u1" },
          data: { projectId: after },
        }),
      );
      expect(sync).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: after,
          verificationToken: "keep-token",
          certificate,
          sslEnabled: true,
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        "u1",
        "domain.updated",
        { type: "Domain", id: "d1" },
        { before: { projectId: before }, after: { projectId: after } },
      );
      if (after === null)
        expect(prisma.project.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "another-user-domain"])(
    "returns 404 for %s",
    async (id) => {
      const { service, prisma } = fixture();
      prisma.domain.findFirst.mockResolvedValue(null as never);
      await expect(
        service.update("u1", id, { projectId: "p2" }),
      ).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND", statusCode: 404 });
      expect(prisma.domain.update).not.toHaveBeenCalled();
      expect(prisma.project.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign-project", "deleted-project", "missing-project"])(
    "rejects %s",
    async (id) => {
      const { service, prisma } = fixture();
      prisma.project.findFirst.mockResolvedValue(null as never);
      await expect(
        service.update("u1", "d1", { projectId: id }),
      ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", statusCode: 404 });
      expect(prisma.project.findFirst).toHaveBeenCalledWith({
        where: { id, userId: "u1", deletedAt: null },
      });
      expect(prisma.domain.update).not.toHaveBeenCalled();
    },
  );

  it("removes routing without removing certificates when unassigned or pending", () => {
    const { service } = fixture();
    vi.mocked(service.syncTraefikRouter).mockRestore();
    const remove = vi
      .spyOn(service, "removeTraefikRouter")
      .mockImplementation(() => {});
    service.syncTraefikRouter({
      id: "d1",
      status: "ACTIVE",
      project: null,
    } as never);
    service.syncTraefikRouter({
      id: "d2",
      status: "PENDING",
      project: null,
    } as never);
    expect(remove).toHaveBeenCalledWith("d1", false);
    expect(remove).toHaveBeenCalledWith("d2", false);
  });

  it.each([
    {},
    { projectId: "" },
    { projectId: null, hostname: "changed.com" },
  ])("rejects invalid assignment input %j", (input) => {
    expect(UpdateDomainSchema.safeParse(input).success).toBe(false);
  });
});

it("rejects an unrelated hostname using an owned ACTIVE parent", async () => {
  const prisma = { domain: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue({ id: "parent", hostname: "owned.example", status: "ACTIVE" }), create: vi.fn() } };
  const service = new DomainService(prisma as never);
  await expect(service.create("u1", { hostname: "unrelated.example", parentId: "parent" } as never)).rejects.toMatchObject({ code: "INVALID_PARENT_DOMAIN" });
  expect(prisma.domain.create).not.toHaveBeenCalled();
});
