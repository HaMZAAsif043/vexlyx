import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { runDockerManager } from "../modules/deploy/service.js";
import { refreshDeployedNginxConfs } from "../utils/nginxConfRefresh.js";

// Bump the version to run the refresh again on the next upgrade.
const MARKER = ".migrations/nginx-served-paths-v1";

const log = (level: string, fields: object, msg: string) =>
  process.stdout.write(JSON.stringify({ level, msg, ...fields }) + "\n");
const logger = {
  info: (fields: object, msg: string) => log("info", fields, msg),
  warn: (fields: object, msg: string) => log("warn", fields, msg),
  error: (fields: object, msg: string) => log("error", fields, msg),
} as unknown as Parameters<typeof refreshDeployedNginxConfs>[1]["logger"];

const markerPath = path.resolve(env.PROJECTS_DIR, "..", MARKER);
const prisma = new PrismaClient();

try {
  if (await fs.stat(markerPath).then(() => true, () => false)) {
    log("info", {}, "nginx configuration refresh already ran; nothing to do");
  } else {
    const result = await refreshDeployedNginxConfs(prisma, {
      projectsDir: env.PROJECTS_DIR,
      logger,
      refresh: (request) =>
        runDockerManager(request, (line) => {
          log("info", { projectId: request.projectId }, line);
        }),
    });
    log("info", result, "nginx configuration refresh finished");
    // A failure leaves the marker unwritten so the next upgrade tries again.
    if (result.failed === 0) {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, new Date().toISOString() + "\n");
    }
  }
} catch (error) {
  // Never fail the upgrade over this: a redeploy applies the same change.
  log("error", { err: error instanceof Error ? error.message : String(error) }, "nginx configuration refresh failed");
} finally {
  await prisma.$disconnect();
}
