import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";

type MigrationLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export interface NetworkMigrationResult {
  attempted: number;
  failed: number;
}

/**
 * One-time repair: projects deployed before the apps network existed sit on
 * the panel-internal network. This moves each one onto the apps network in
 * place (containers keep running, stopped ones stay stopped) and updates its
 * compose file to match. A project that fails is logged and the rest carry on.
 */
export async function migrateProjectsToAppsNetwork(
  prisma: PrismaClient,
  options: {
    projectsDir: string;
    logger: MigrationLogger;
    migrate: (request: Record<string, unknown>) => Promise<void>;
  },
): Promise<NetworkMigrationResult> {
  const { projectsDir, logger, migrate } = options;
  const result: NetworkMigrationResult = { attempted: 0, failed: 0 };

  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
  });

  for (const project of projects) {
    result.attempted++;
    try {
      await migrate({
        command: "migrate_network",
        projectId: project.id,
        projectDir: path.resolve(projectsDir, project.id),
      });
    } catch (err) {
      result.failed++;
      logger.error(
        { err, projectId: project.id, name: project.name },
        "Could not move the project onto the apps network",
      );
    }
  }
  return result;
}
