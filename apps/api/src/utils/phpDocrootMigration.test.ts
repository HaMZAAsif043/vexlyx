import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handExistingDocrootsToPhp } from "./phpDocrootMigration.js";

type Row = { id: string; type: string; buildCmd: string | null; name: string };

describe("handExistingDocrootsToPhp", () => {
  let projectsDir: string;
  let changed: string[];
  const chown = async (p: string) => {
    changed.push(path.relative(projectsDir, p).replace(/\\/g, "/"));
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  function prismaWith(rows: Row[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { prisma: { project: { findMany } } as unknown as PrismaClient, findMany };
  }

  beforeEach(async () => {
    projectsDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-mig-")));
    changed = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("only asks for live PHP-FPM projects", async () => {
    const { prisma, findMany } = prismaWith([]);
    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    const where = findMany.mock.calls[0]![0].where;
    expect(where.deletedAt).toBeNull();
    expect(JSON.stringify(where)).toContain("WORDPRESS");
    expect(JSON.stringify(where)).toContain('"PHP"');
  });

  it("hands each no-build PHP project's docroot directory over, and nothing inside it", async () => {
    await fs.mkdir(path.join(projectsDir, "p1", "deploy"), { recursive: true });
    await fs.writeFile(path.join(projectsDir, "p1", "index.php"), "x");
    const { prisma } = prismaWith([{ id: "p1", type: "PHP", buildCmd: null, name: "Shop" }]);

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual(["p1"]);
    expect(result).toMatchObject({ changed: 1, skipped: 0, failed: 0 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", name: "Shop" }),
      expect.stringContaining("PHP"),
    );
  });

  it("hands a WordPress project's wp-content and its writable folders over", async () => {
    for (const dir of ["plugins", "themes", "uploads", "cache"]) {
      await fs.mkdir(path.join(projectsDir, "wp1", "wp-content", dir), { recursive: true });
    }
    const { prisma } = prismaWith([{ id: "wp1", type: "WORDPRESS", buildCmd: null, name: "Blog" }]);

    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed.sort()).toEqual([
      "wp1/wp-content",
      "wp1/wp-content/plugins",
      "wp1/wp-content/themes",
      "wp1/wp-content/uploads",
    ]);
  });

  it("skips a project whose directory is gone and reports it", async () => {
    const { prisma } = prismaWith([{ id: "ghost", type: "PHP", buildCmd: null, name: "Ghost" }]);

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(result).toMatchObject({ changed: 0, skipped: 1, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "ghost" }),
      expect.any(String),
    );
  });

  it("ignores Nixpacks-built PHP and other types even if the query returned them", async () => {
    await fs.mkdir(path.join(projectsDir, "built"));
    await fs.mkdir(path.join(projectsDir, "node"));
    const { prisma } = prismaWith([
      { id: "built", type: "PHP", buildCmd: "composer install", name: "B" },
      { id: "node", type: "NODEJS", buildCmd: null, name: "N" },
    ]);

    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual([]);
  });

  it("reports a failing project and carries on with the rest", async () => {
    await fs.mkdir(path.join(projectsDir, "bad"));
    await fs.mkdir(path.join(projectsDir, "good"));
    const { prisma } = prismaWith([
      { id: "bad", type: "PHP", buildCmd: null, name: "Bad" },
      { id: "good", type: "PHP", buildCmd: null, name: "Good" },
    ]);
    const flaky = async (p: string) => {
      if (p.endsWith("bad")) throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
      await chown(p);
    };

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown: flaky, logger });

    expect(result).toMatchObject({ changed: 1, failed: 1 });
    expect(changed).toEqual(["good"]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "bad" }),
      expect.any(String),
    );
  });

  it("leaves the root of a git-connected project alone and says so", async () => {
    await fs.mkdir(path.join(projectsDir, "g1", ".git"), { recursive: true });
    const { prisma } = prismaWith([{ id: "g1", type: "PHP", buildCmd: null, name: "Git site" }]);

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual([]);
    expect(result).toMatchObject({ changed: 0, skipped: 1, failed: 0 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "g1" }),
      expect.stringContaining("git"),
    );
  });

  it("still repairs the plain projects next to a git-connected one", async () => {
    await fs.mkdir(path.join(projectsDir, "g1", ".git"), { recursive: true });
    await fs.mkdir(path.join(projectsDir, "p1"));
    const { prisma } = prismaWith([
      { id: "g1", type: "PHP", buildCmd: null, name: "Git site" },
      { id: "p1", type: "PHP", buildCmd: null, name: "Plain" },
    ]);

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual(["p1"]);
    expect(result).toMatchObject({ changed: 1, skipped: 1 });
  });

  it("does not change WordPress handling when the project directory has a .git", async () => {
    await fs.mkdir(path.join(projectsDir, "wp1", ".git"), { recursive: true });
    await fs.mkdir(path.join(projectsDir, "wp1", "wp-content"));
    const { prisma } = prismaWith([{ id: "wp1", type: "WORDPRESS", buildCmd: null, name: "Blog" }]);

    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual(["wp1/wp-content"]);
  });

  it("is idempotent: running again changes the same directories and nothing more", async () => {
    await fs.mkdir(path.join(projectsDir, "p1"));
    const { prisma } = prismaWith([{ id: "p1", type: "PHP", buildCmd: null, name: "Shop" }]);

    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });
    await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual(["p1", "p1"]);
  });

  it("never follows a project directory that is a symlink", async () => {
    if (process.platform === "win32") return;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-out-"));
    await fs.symlink(outside, path.join(projectsDir, "linked"));
    const { prisma } = prismaWith([{ id: "linked", type: "PHP", buildCmd: null, name: "L" }]);

    const result = await handExistingDocrootsToPhp(prisma, { projectsDir, chown, logger });

    expect(changed).toEqual([]);
    expect(result.skipped).toBe(1);
    await fs.rm(outside, { recursive: true, force: true });
  });
});
