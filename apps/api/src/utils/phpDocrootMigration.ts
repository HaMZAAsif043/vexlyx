import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  handOverToPhp,
  isGitCheckout,
  phpDocrootTargets,
  phpOwnershipScope,
} from "./phpRuntimeOwnership.js";

export interface DocrootMigrationResult {
  changed: number;
  skipped: number;
  failed: number;
}

type MigrationLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/**
 * One-time repair for projects deployed before #151: hands the directories
 * PHP-FPM writes to over to it. Deploys now do this themselves, so without
 * this a project such as a migrated WordPress site would stay unwritable until
 * somebody redeployed it. Non-recursive and idempotent; a project that fails
 * is reported and the rest carry on.
 */
export async function handExistingDocrootsToPhp(
  prisma: PrismaClient,
  options: {
    projectsDir: string;
    logger: MigrationLogger;
    chown?: (target: string) => Promise<void>;
  },
): Promise<DocrootMigrationResult> {
  const { projectsDir, logger } = options;
  const result: DocrootMigrationResult = { changed: 0, skipped: 0, failed: 0 };

  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      OR: [
        { type: "WORDPRESS" },
        { type: "PHP", OR: [{ buildCmd: null }, { buildCmd: "" }] },
      ],
    },
    select: { id: true, name: true, type: true, buildCmd: true },
  });

  for (const project of projects) {
    const scope = phpOwnershipScope(project);
    if (!scope) continue;

    const projectDir = path.resolve(projectsDir, project.id);
    const stat = await fs.lstat(projectDir).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      result.skipped++;
      logger.warn(
        { projectId: project.id, name: project.name },
        "Skipped PHP docroot ownership: the project directory is missing or not a directory",
      );
      continue;
    }

    if (scope === "project" && (await isGitCheckout(projectDir))) {
      result.skipped++;
      logger.info(
        { projectId: project.id, name: project.name },
        "Left the root of this git-connected PHP project root-owned: git runs as root and refuses a repository another user owns",
      );
      continue;
    }

    try {
      const targets = await existingDirectories(phpDocrootTargets(projectDir, scope));
      await handOverToPhp(projectDir, targets, scope, { chown: options.chown });
      if (targets.length === 0) {
        result.skipped++;
        continue;
      }
      result.changed++;
      logger.info(
        { projectId: project.id, name: project.name, directories: targets.length },
        "Made the PHP-FPM docroot writable for its user",
      );
    } catch (err) {
      result.failed++;
      logger.error(
        { err, projectId: project.id, name: project.name },
        "Could not make the PHP docroot writable for its user",
      );
    }
  }

  return result;
}

async function existingDirectories(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat?.isDirectory()) found.push(candidate);
  }
  return found;
}
