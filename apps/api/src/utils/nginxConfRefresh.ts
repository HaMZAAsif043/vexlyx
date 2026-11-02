import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";

type RefreshLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

export interface NginxRefreshResult {
  attempted: number;
  failed: number;
}

/**
 * One-time repair: a site's nginx.conf is generated into its deploy/ directory
 * at deploy time, so a change to the template (here: not serving deploy/ and
 * dot files) only reaches a site on its next deploy. This re-renders the
 * config of every site that serves its project directory and reloads nginx.
 * Only no-build static/React and no-build PHP serve the project directory;
 * WordPress and built sites do not. A project that fails is logged and the
 * rest carry on.
 */
export async function refreshDeployedNginxConfs(
  prisma: PrismaClient,
  options: {
    projectsDir: string;
    logger: RefreshLogger;
    refresh: (request: Record<string, unknown>) => Promise<void>;
  },
): Promise<NginxRefreshResult> {
  const { projectsDir, logger, refresh } = options;
  const result: NginxRefreshResult = { attempted: 0, failed: 0 };

  const projects = await prisma.project.findMany({
    where: {
      deletedAt: null,
      OR: [
        { type: { in: ["STATIC", "REACT"] } },
        { type: "PHP", OR: [{ buildCmd: null }, { buildCmd: "" }] },
      ],
    },
    select: { id: true, name: true, type: true, buildCmd: true },
  });

  for (const project of projects) {
    if (project.type === "PHP" && project.buildCmd) continue;
    result.attempted++;
    try {
      await refresh({
        command: "refresh_nginx_conf",
        projectDir: path.resolve(projectsDir, project.id),
        projectType: project.type,
        projectId: project.id,
        phpNoBuild: project.type === "PHP" && !project.buildCmd,
      });
    } catch (err) {
      result.failed++;
      logger.error(
        { err, projectId: project.id, name: project.name },
        "Could not refresh the site's nginx configuration",
      );
    }
  }
  return result;
}
