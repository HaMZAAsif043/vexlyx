import type { PrismaClient } from "@prisma/client";
import { notifyUser } from "../modules/system-email/notifier.js";

export type QuotaResource = "project" | "domain" | "database" | "mailbox" | "subAccount" | "scheduledTask";

/** Resources that participate in reseller pooling/overselling (F5.20). `subAccount` is excluded — there's no reseller-of-reseller nesting, so sub-account counts don't aggregate the same way. */
type PoolResource = Exclude<QuotaResource, "subAccount">;

const QUOTA_RESOURCES: QuotaResource[] = ["project", "domain", "database", "mailbox", "subAccount", "scheduledTask"];
const POOL_RESOURCES: PoolResource[] = ["project", "domain", "database", "mailbox", "scheduledTask"];

const QUOTA_FIELD: Record<QuotaResource, string> = {
  project: "maxProjects",
  domain: "maxDomains",
  database: "maxDatabases",
  mailbox: "maxMailboxes",
  subAccount: "maxSubAccounts",
  scheduledTask: "maxScheduledTasks",
};

export interface QuotaUsage {
  used: number;
  limit: number | null;
  /** Reseller-only (F5.20): sum of all sub-accounts' quota for this resource. Null means at least one sub-account is unlimited. */
  nominalSum?: number | null;
  /** Reseller-only (F5.20): true when nominalSum exceeds limit. */
  oversold?: boolean;
}

async function countExisting(prisma: PrismaClient, userId: string, resource: QuotaResource): Promise<number> {
  switch (resource) {
    case "project":
      return prisma.project.count({ where: { userId, status: { not: "DELETED" } } });
    case "domain":
      return prisma.domain.count({ where: { userId } });
    case "database":
      return prisma.database.count({ where: { userId } });
    case "mailbox":
      return prisma.mailbox.count({ where: { userId, status: { not: "DELETED" } } });
    case "subAccount":
      return prisma.user.count({ where: { resellerId: userId } });
    case "scheduledTask":
      // A soft-deleted project keeps its rows, and its tasks are then
      // unreachable from the panel (list 404s) — counting them would let a
      // deleted project block its owner (and the reseller pool) forever.
      return prisma.scheduledTask.count({ where: { userId, project: { deletedAt: null } } });
  }
}

/** Sums `countExisting` across a reseller and all of their sub-accounts — the "real aggregate usage" side of overselling mode. */
async function sumAcrossPool(prisma: PrismaClient, resellerId: string, resource: QuotaResource): Promise<number> {
  const members = await prisma.user.findMany({
    where: { OR: [{ id: resellerId }, { resellerId }] },
    select: { id: true },
  });
  const counts = await Promise.all(members.map((m) => countExisting(prisma, m.id, resource)));
  return counts.reduce((sum, c) => sum + c, 0);
}

/**
 * Throws `err` (constructed via `makeError`) if creating one more `resource`
 * would put `userId` at or over their configured quota. A null quota field
 * means unlimited, so the check is skipped entirely.
 *
 * F5.20: when `userId` sits under a reseller with overselling enabled (or is
 * themselves such a reseller), also asserts that real aggregate usage across
 * the reseller + all sub-accounts stays under the reseller's own limit. This
 * only ever adds a check — resellers with overselling off, and users with no
 * reseller at all, see exactly the per-user check that existed before F5.20.
 */
export async function assertUnderQuota(
  prisma: PrismaClient,
  userId: string,
  resource: QuotaResource,
  makeError: (message: string, code: string, statusCode: number) => Error,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, resellerId: true, [QUOTA_FIELD[resource]]: true } as Record<string, true>,
  });
  const record = user as Record<string, unknown> | null;

  const limit = (record?.[QUOTA_FIELD[resource]] as number | null | undefined) ?? null;
  if (limit !== null && limit !== undefined) {
    const current = await countExisting(prisma, userId, resource);
    if (current >= limit) {
      throw makeError(
        `You have reached your ${resource} limit (${limit}). Contact your administrator to increase it.`,
        "QUOTA_EXCEEDED",
        403,
      );
    }
  }

  if (resource === "subAccount") return;

  const resellerId = record?.resellerId as string | null | undefined;
  const role = record?.role as string | undefined;
  const poolResellerId = resellerId ?? (role === "RESELLER" ? userId : null);
  if (!poolResellerId) return;

  const reseller = await prisma.user.findUnique({
    where: { id: poolResellerId },
    select: { oversellingEnabled: true, [QUOTA_FIELD[resource]]: true } as Record<string, true>,
  });
  const resellerRecord = reseller as Record<string, unknown> | null;
  if (!resellerRecord?.oversellingEnabled) return;

  const poolLimit = (resellerRecord[QUOTA_FIELD[resource]] as number | null | undefined) ?? null;
  if (poolLimit === null || poolLimit === undefined) return;

  const poolUsed = await sumAcrossPool(prisma, poolResellerId, resource);
  if (poolUsed >= poolLimit) {
    throw makeError(
      `Your reseller has reached the aggregate ${resource} limit (${poolLimit}) across all sub-accounts. Contact your administrator to increase it.`,
      "QUOTA_EXCEEDED",
      403,
    );
  }
}

/**
 * F5.20: when a reseller has overselling disabled (the default), a
 * sub-account's quota may never push the nominal sum of all the reseller's
 * sub-account quotas above the reseller's own limit. Called from
 * `UserService.updateQuotas` before writing a sub-account's new quotas.
 * `finalQuotas` must be the target sub-account's fully-merged values (its
 * existing values overlaid with whatever this update changes) — not a diff.
 */
export async function assertNominalPoolWithinCap(
  prisma: PrismaClient,
  resellerId: string,
  targetSubAccountId: string,
  finalQuotas: Record<PoolResource, number | null>,
  makeError: (message: string, code: string, statusCode: number) => Error,
): Promise<void> {
  const reseller = await prisma.user.findUnique({
    where: { id: resellerId },
    select: {
      oversellingEnabled: true,
      maxProjects: true,
      maxDomains: true,
      maxDatabases: true,
      maxMailboxes: true,
      maxScheduledTasks: true,
    },
  });
  if (!reseller || reseller.oversellingEnabled) return;

  const siblings = await prisma.user.findMany({
    where: { resellerId, id: { not: targetSubAccountId } },
    select: { maxProjects: true, maxDomains: true, maxDatabases: true, maxMailboxes: true, maxScheduledTasks: true },
  });

  for (const resource of POOL_RESOURCES) {
    const field = QUOTA_FIELD[resource] as keyof typeof reseller;
    const resellerLimit = reseller[field] as number | null;
    if (resellerLimit === null) continue;

    const siblingValues = siblings.map((s) => s[field as keyof (typeof siblings)[number]] as number | null);
    const allValues = [...siblingValues, finalQuotas[resource]];

    if (allValues.some((v) => v === null)) {
      throw makeError(
        `Cannot leave ${resource} quota unlimited for a sub-account while your ${resource} limit (${resellerLimit}) is set — this would exceed your total capacity. Enable overselling mode to allow this.`,
        "OVERSELL_NOT_ENABLED",
        403,
      );
    }

    const total = (allValues as number[]).reduce((sum, v) => sum + v, 0);
    if (total > resellerLimit) {
      throw makeError(
        `Setting this would put your total sub-account ${resource} allocations at ${total}, over your limit of ${resellerLimit}. Enable overselling mode to allow this.`,
        "OVERSELL_NOT_ENABLED",
        403,
      );
    }
  }
}

/**
 * Full used/limit breakdown across every quota'd resource for a user — the
 * data behind the "Your Plan" dashboard widget so users can see what
 * they're allowed before hitting a QUOTA_EXCEEDED error.
 *
 * F5.20: for a RESELLER, also reports `nominalSum`/`oversold` per resource so
 * the UI can flag oversold territory (nominal sub-account allocations above
 * the reseller's own limit) regardless of whether overselling is enabled.
 */
export async function getUsageSummary(
  prisma: PrismaClient,
  userId: string,
): Promise<Record<QuotaResource, QuotaUsage>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      maxProjects: true,
      maxDomains: true,
      maxDatabases: true,
      maxMailboxes: true,
      maxSubAccounts: true,
      maxScheduledTasks: true,
    },
  });

  const limits = user as Record<string, unknown> | null;
  const isReseller = user?.role === "RESELLER";

  const subAccountQuotas = isReseller
    ? await prisma.user.findMany({
        where: { resellerId: userId },
        select: { maxProjects: true, maxDomains: true, maxDatabases: true, maxMailboxes: true, maxScheduledTasks: true },
      })
    : [];

  const entries = await Promise.all(
    QUOTA_RESOURCES.map(async (resource) => {
      const used = await countExisting(prisma, userId, resource);
      const limit = (limits?.[QUOTA_FIELD[resource]] as number | null | undefined) ?? null;
      const usage: QuotaUsage = { used, limit };

      if (isReseller && resource !== "subAccount") {
        const field = QUOTA_FIELD[resource] as keyof (typeof subAccountQuotas)[number];
        const values = subAccountQuotas.map((s) => s[field]);
        const nominalSum = values.some((v) => v === null) ? null : (values as number[]).reduce((sum, v) => sum + v, 0);
        usage.nominalSum = nominalSum;
        usage.oversold = limit !== null && (nominalSum === null || nominalSum > limit);
      }

      return [resource, usage] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<QuotaResource, QuotaUsage>;
}

/** Usage percentages at which a quota-warning email is sent (F5.23). */
const WARNING_LEVELS = [80, 100] as const;

/**
 * Emails the user once when their usage of `resource` crosses 80% and again at
 * 100% of their own limit. Call after a successful create. A QuotaNotice row
 * records each warning already sent, so later requests stay silent; the row is
 * removed once usage drops back under its threshold, re-arming the warning.
 * Never throws — a notification must not fail the create that triggered it.
 * Pooled reseller limits (F5.20) are not considered; only the user's own cap.
 */
export async function notifyQuotaThreshold(
  prisma: PrismaClient,
  userId: string,
  resource: QuotaResource,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, [QUOTA_FIELD[resource]]: true } as Record<string, true>,
    });
    const limit = (user as Record<string, unknown> | null)?.[QUOTA_FIELD[resource]] as number | null | undefined;
    if (!user || limit === null || limit === undefined || limit <= 0) return;

    const used = await countExisting(prisma, userId, resource);
    const percent = (used / limit) * 100;

    const newlyReached: number[] = [];
    for (const level of WARNING_LEVELS) {
      if (percent < level) {
        await prisma.quotaNotice.deleteMany({ where: { userId, resource, level } });
        continue;
      }
      const alreadySent = await prisma.quotaNotice.findUnique({
        where: { userId_resource_level: { userId, resource, level } },
      });
      if (alreadySent) continue;
      await prisma.quotaNotice.create({ data: { userId, resource, level } });
      newlyReached.push(level);
    }

    if (newlyReached.length === 0) return;
    // Both thresholds can be crossed in one step (e.g. a limit of 1): send only the strongest.
    const level = Math.max(...newlyReached) as 80 | 100;
    notifyUser("quota_warning", String(user.email), { name: String(user.name), resource, used, limit, level });
  } catch {
    // Swallowed on purpose: see the docblock above.
  }
}
