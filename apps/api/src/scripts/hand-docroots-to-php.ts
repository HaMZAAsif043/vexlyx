import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";
import { handExistingDocrootsToPhp } from "../utils/phpDocrootMigration.js";
import { canChangeOwnership } from "../utils/phpRuntimeOwnership.js";

// Bump the version to run the repair again on the next upgrade.
const MARKER = ".migrations/php-docroot-ownership-v1";

const log = (level: string, fields: object, msg: string) =>
  process.stdout.write(JSON.stringify({ level, msg, ...fields }) + "\n");
const logger = {
  info: (fields: object, msg: string) => log("info", fields, msg),
  warn: (fields: object, msg: string) => log("warn", fields, msg),
  error: (fields: object, msg: string) => log("error", fields, msg),
} as unknown as Parameters<typeof handExistingDocrootsToPhp>[1]["logger"];

const markerPath = path.resolve(env.PROJECTS_DIR, "..", MARKER);
const prisma = new PrismaClient();

try {
  if (await fs.stat(markerPath).then(() => true, () => false)) {
    log("info", {}, "PHP docroot ownership repair already ran; nothing to do");
  } else if (!canChangeOwnership()) {
    log("warn", {}, "Not running as root; PHP docroot ownership repair skipped");
  } else {
    const result = await handExistingDocrootsToPhp(prisma, {
      projectsDir: env.PROJECTS_DIR,
      logger,
    });
    log("info", result, "PHP docroot ownership repair finished");
    // A failure leaves the marker unwritten so the next upgrade tries again.
    if (result.failed === 0) {
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, new Date().toISOString() + "\n");
    }
  }
} catch (error) {
  // Never fail the upgrade over this: deploys fix ownership on their own.
  log("error", { err: error instanceof Error ? error.message : String(error) }, "PHP docroot ownership repair failed");
} finally {
  await prisma.$disconnect();
}
