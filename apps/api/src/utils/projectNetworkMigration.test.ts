import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateProjectsToAppsNetwork } from "./projectNetworkMigration.js";

describe("migrateProjectsToAppsNetwork", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const projectsDir = path.resolve("/data/projects");

  function prismaWith(rows: { id: string; name: string }[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { prisma: { project: { findMany } } as unknown as PrismaClient, findMany };
  }

  beforeEach(() => vi.clearAllMocks());

  it("covers every project that has not been deleted, running or not", async () => {
    const { prisma, findMany } = prismaWith([]);
    await migrateProjectsToAppsNetwork(prisma, { projectsDir, logger, migrate: vi.fn() });

    expect(findMany.mock.calls[0]![0].where).toEqual({ deletedAt: null });
  });

  it("sends each project's id and directory to the migrate_network action", async () => {
    const { prisma } = prismaWith([
      { id: "p1", name: "Shop" },
      { id: "p2", name: "Docs" },
    ]);
    const migrate = vi.fn().mockResolvedValue(undefined);

    const result = await migrateProjectsToAppsNetwork(prisma, { projectsDir, logger, migrate });

    expect(migrate).toHaveBeenCalledWith({
      command: "migrate_network",
      projectId: "p1",
      projectDir: path.join(projectsDir, "p1"),
    });
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, failed: 0 });
  });

  it("logs a failing project, counts it and carries on with the rest", async () => {
    const { prisma } = prismaWith([
      { id: "p1", name: "Broken" },
      { id: "p2", name: "Fine" },
    ]);
    const migrate = vi
      .fn()
      .mockRejectedValueOnce(new Error("docker unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await migrateProjectsToAppsNetwork(prisma, { projectsDir, logger, migrate });

    expect(result).toEqual({ attempted: 2, failed: 1 });
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", name: "Broken" }),
      expect.any(String),
    );
  });
});
