import { beforeEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("../../config/env.js", () => ({ env: { PROJECTS_DIR: "D:/nonexistent-project-workspaces" } }));
vi.mock("node:fs/promises", () => ({ default: { rm: vi.fn() } }));
vi.mock("../deploy/service.js", () => ({ runDockerAction: vi.fn() }));
vi.mock("../../utils/quota.js", () => ({ assertUnderQuota: vi.fn(), notifyQuotaThreshold: vi.fn() }));
import fs from "node:fs/promises";
import { runDockerAction } from "../deploy/service.js";
import { ProjectService } from "./service.js";

beforeEach(() => { vi.clearAllMocks(); vi.mocked(runDockerAction).mockResolvedValue(); });
function setup(deletedAt: Date | null = null) {
  const project = { id: "p1", userId: "u1", name: "app", type: "DOCKER", deletedAt };
  const prisma = { project: { findUnique: vi.fn().mockResolvedValue(project), update: vi.fn() }, scheduledTask: { findMany: vi.fn().mockResolvedValue([]) } };
  const service = new ProjectService(prisma as unknown as PrismaClient, { log: vi.fn() } as never, { error: vi.fn() } as never);
  return { service, prisma };
}
it("cleans volumes by project identity even without a workspace", async () => {
  const { service, prisma } = setup();
  await service.softDelete("u1", "p1");
  expect(runDockerAction).toHaveBeenCalledWith("remove", expect.stringContaining("p1"));
  expect(prisma.project.update).toHaveBeenCalledOnce();
});
it("keeps the record and workspace retryable after Docker cleanup fails", async () => {
  const { service, prisma } = setup();
  vi.mocked(runDockerAction).mockRejectedValueOnce(new Error("volume busy"));
  await expect(service.softDelete("u1", "p1")).rejects.toMatchObject({ code: "PROJECT_CLEANUP_FAILED" });
  expect(fs.rm).not.toHaveBeenCalled();
  expect(prisma.project.update).not.toHaveBeenCalled();
  await service.softDelete("u1", "p1");
  expect(prisma.project.update).toHaveBeenCalledOnce();
});
it("permits an owner to retry cleanup of a historical soft-deleted project", async () => {
  await expect(setup(new Date()).service.softDelete("u1", "p1")).resolves.toBeUndefined();
});
it("never cleans another owner's project", async () => {
  await expect(setup().service.softDelete("other", "p1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(runDockerAction).not.toHaveBeenCalled();
});
