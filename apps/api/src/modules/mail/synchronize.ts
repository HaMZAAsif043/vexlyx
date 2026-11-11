import type { PrismaClient } from "@prisma/client";
import { reconcileMailState, MailStateSyncError } from "./state-sync.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import { resolvePythonScript } from "../../utils/pythonScript.js";
import { MailError } from "./errors.js";

export async function synchronizeMailState(prisma: PrismaClient) {
  const readSnapshot = async () => {
    const [domains, aliases] = await prisma.$transaction(
      [
        prisma.domain.findMany({
          select: {
            hostname: true,
            userId: true,
            mailboxes: {
              select: { address: true, password: true, quota: true },
            },
          },
        }),
        prisma.virtualAlias.findMany({
          select: { source: true, destinations: true, userId: true },
        }),
      ],
      { isolationLevel: "RepeatableRead" },
    );
    return { domains, aliases };
  };
  let synchronized: Awaited<ReturnType<typeof readSnapshot>> | undefined;
  try {
    await reconcileMailState(
      getPythonBin(),
      resolvePythonScript("postfix_manager.py", import.meta.url),
      async () => {
        synchronized = await readSnapshot();
        return {
          domains: synchronized.domains.map((domain) => domain.hostname),
          mailboxes: synchronized.domains.flatMap((domain) =>
            domain.mailboxes.map((mailbox) => ({
              address: mailbox.address,
              passwordHash: mailbox.password,
              quotaMb: mailbox.quota,
            })),
          ),
          aliases: synchronized.aliases.map((alias) => ({
            source: alias.source,
            destinations: alias.destinations,
          })),
        };
      },
    );
  } catch (error) {
    if (error instanceof MailStateSyncError)
      throw new MailError(error.message, error.code, 503, error.details);
    throw error;
  }
  if (!synchronized)
    throw new MailError(
      "Mail synchronization did not read a database snapshot.",
      "MAIL_SYNC_PROTOCOL_ERROR",
      503,
    );
  return synchronized;
}
