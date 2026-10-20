import { PrismaClient } from "@prisma/client";
import { synchronizeMailState } from "../modules/mail/service.js";

const prisma = new PrismaClient();
try {
  const snapshot = await synchronizeMailState(prisma);
  process.stdout.write(
    JSON.stringify({
      success: true,
      domains: snapshot.domains.length,
      mailboxes: snapshot.domains.reduce(
        (count, domain) => count + domain.mailboxes.length,
        0,
      ),
    }) + "\n",
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof Error ? error.message : "Mail synchronization failed",
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
