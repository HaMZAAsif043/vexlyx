import { PrismaClient } from "@prisma/client";
import { reencryptSecrets } from "../src/utils/reencryptSecrets.js";

/**
 * Re-encrypts values still readable only through the legacy SESSION_SECRET
 * key under the current ENCRYPTION_KEY (#69). Run once after setting
 * ENCRYPTION_KEY with ENCRYPTION_KEY_LEGACY_FALLBACK=true:
 *
 *   pnpm db:reencrypt --dry-run   # report only
 *   pnpm db:reencrypt             # apply
 */
const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const result = await reencryptSecrets(prisma, { dryRun });
  for (const item of result.unreadable) {
    console.error(`Could not decrypt ${item}; left unchanged.`);
  }
  console.log(
    `${dryRun ? "[dry run] would re-encrypt" : "Re-encrypted"} ${result.migrated} value(s); ` +
      `${result.current} already on the current key; ${result.unreadable.length} unreadable.`,
  );
  if (result.unreadable.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
