import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshDeployedNginxConfs } from "./nginxConfRefresh.js";

type Row = { id: string; name: string; type: string; buildCmd: string | null };

describe("refreshDeployedNginxConfs", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const projectsDir = path.resolve("/data/projects");

  function prismaWith(rows: Row[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { prisma: { project: { findMany } } as unknown as PrismaClient, findMany };
  }

  beforeEach(() => vi.clearAllMocks());

  it("only asks for live projects of the types that serve their project directory", async () => {
    const { prisma, findMany } = prismaWith([]);
    await refreshDeployedNginxConfs(prisma, { projectsDir, logger, refresh: vi.fn() });

    const where = findMany.mock.calls[0]![0].where;
    expect(where.deletedAt).toBeNull();
    const text = JSON.stringify(where);
    expect(text).toContain("STATIC");
    expect(text).toContain("REACT");
    expect(text).toContain('"PHP"');
    expect(text).not.toContain("WORDPRESS");
  });

  it("sends each project's directory, type, id and whether PHP has no build step", async () => {
    const { prisma } = prismaWith([
      { id: "s1", name: "Docs", type: "STATIC", buildCmd: null },
      { id: "p1", name: "Shop", type: "PHP", buildCmd: null },
      { id: "p2", name: "Built", type: "PHP", buildCmd: "composer install" },
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);

    await refreshDeployedNginxConfs(prisma, { projectsDir, logger, refresh });

    expect(refresh).toHaveBeenCalledWith({
      command: "refresh_nginx_conf",
      projectDir: path.join(projectsDir, "s1"),
      projectType: "STATIC",
      projectId: "s1",
      phpNoBuild: false,
    });
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", projectType: "PHP", phpNoBuild: true }),
    );
    // Nixpacks-built PHP does not serve its directory; it is not refreshed.
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("counts a project whose refresh fails, logs it and carries on", async () => {
    const { prisma } = prismaWith([
      { id: "bad", name: "Bad", type: "STATIC", buildCmd: null },
      { id: "good", name: "Good", type: "STATIC", buildCmd: null },
    ]);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("docker unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await refreshDeployedNginxConfs(prisma, { projectsDir, logger, refresh });

    expect(result).toEqual({ attempted: 2, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "bad" }),
      expect.any(String),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reports nothing to do when there are no such projects", async () => {
    const { prisma } = prismaWith([]);
    const result = await refreshDeployedNginxConfs(prisma, { projectsDir, logger, refresh: vi.fn() });
    expect(result).toEqual({ attempted: 0, failed: 0 });
  });
});
