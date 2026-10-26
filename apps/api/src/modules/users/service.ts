import type { PrismaClient, Role } from "@prisma/client";
import * as argon2 from "argon2";
import type {
  CreateSubAccountInput,
  UpdateUserRoleInput,
  UpdateUserQuotasInput,
  UpdateUserPermissionsInput,
} from "./schema.js";
import { assertNominalPoolWithinCap, assertUnderQuota, getUsageSummary, notifyQuotaThreshold } from "../../utils/quota.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";

export class UserError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "UserError";
  }
}

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  resellerId: true,
  maxProjects: true,
  maxDomains: true,
  maxDatabases: true,
  maxMailboxes: true,
  maxSubAccounts: true,
  maxScheduledTasks: true,
  maxRedisInstances: true,
  permissions: true,
  oversellingEnabled: true,
  createdAt: true,
} as const;

interface Requester {
  id: string;
  role: Role;
}

export class UserService {
  constructor(
    private prisma: PrismaClient,
    private auditLog: AuditLogService,
    /**
     * Called with the id of a user that was just deleted, so their live
     * connections can be ended (#64). Injected rather than imported to keep this
     * service free of the socket server.
     */
    private onUserDeleted?: (userId: string) => void,
    /**
     * Ends every session of a user about to be deleted. Must run BEFORE the row
     * is deleted: the session rows cascade away with it, which would lose the
     * ids needed to remove their Redis entries, and a deleted user's cookie
     * would stay valid until the Redis TTL expires. Injected for the same
     * reason as onUserDeleted.
     */
    private revokeSessions?: (userId: string) => Promise<void>,
    /**
     * Tears down the user's Redis instance resources (containers, volumes,
     * configs). Must run BEFORE the row is deleted: RedisInstance rows cascade
     * away with the user, which would leave running containers with no record
     * left to manage them. Injected for the same reason as onUserDeleted.
     */
    private teardownRedisInstances?: (userId: string) => Promise<void>,
  ) {}

  /**
   * Used/limit breakdown for every quota'd resource, for the caller's own
   * account — powers the "Your Plan" dashboard widget.
   */
  async getUsageSummary(userId: string) {
    return getUsageSummary(this.prisma, userId);
  }

  /**
   * ADMIN sees every user; RESELLER sees only themselves and their own
   * sub-accounts (F5.5 reseller scoping).
   */
  async list(requester: Requester) {
    const where = requester.role === "ADMIN" ? {} : { OR: [{ id: requester.id }, { resellerId: requester.id }] };

    return this.prisma.user.findMany({
      where,
      select: PUBLIC_USER_SELECT,
      orderBy: { createdAt: "asc" },
    });
  }

  // Role changes are ADMIN-only, always — never callable by a RESELLER, so
  // no ownership check is needed here (unlike updateQuotas/delete below).
  // An ADMIN may not change their own role, though — same reasoning as
  // "you cannot delete your own account" in delete() below: it prevents an
  // admin from accidentally demoting/locking themselves out with no one
  // else able to undo it.
  async updateRole(requester: Requester, id: string, data: UpdateUserRoleInput) {
    if (id === requester.id) {
      throw new UserError("You cannot change your own role", "CANNOT_CHANGE_OWN_ROLE", 400);
    }

    const target = await this.ensureExists(id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: { role: data.role },
      select: PUBLIC_USER_SELECT,
    });

    await this.auditLog.log(
      requester.id,
      "user.role_changed",
      { type: "User", id },
      { before: { role: target.role }, after: { role: data.role } },
    );

    notifyUser("role_changed", updated.email, { name: updated.name, newRole: data.role });

    return updated;
  }

  // Permission grants are ADMIN-only, always — same reasoning as
  // updateRole above: never callable by a RESELLER, so no ownership check.
  async updatePermissions(requester: Requester, id: string, data: UpdateUserPermissionsInput) {
    const target = await this.ensureExists(id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: { permissions: data.permissions },
      select: PUBLIC_USER_SELECT,
    });

    await this.auditLog.log(
      requester.id,
      "user.permissions_changed",
      { type: "User", id },
      { before: { permissions: target.permissions }, after: { permissions: data.permissions } },
    );

    return updated;
  }

  /**
   * ADMIN can update any user's quotas; RESELLER can only update quotas on
   * their own sub-accounts (never themselves, another reseller, or admin).
   *
   * F5.20: `oversellingEnabled` is ADMIN-only and only meaningful on a
   * RESELLER target. When the target is itself a sub-account and its
   * reseller has overselling disabled (the default), the new quota values
   * must not push the reseller's nominal sub-account sum above the
   * reseller's own limit.
   */
  async updateQuotas(requester: Requester, id: string, data: UpdateUserQuotasInput) {
    const target = await this.ensureExists(id);
    this.assertCanManage(requester, target);

    if (data.oversellingEnabled !== undefined) {
      if (requester.role !== "ADMIN") {
        throw new UserError("Only an administrator can change overselling mode", "FORBIDDEN", 403);
      }
      if (target.role !== "RESELLER") {
        throw new UserError("Overselling mode only applies to reseller accounts", "INVALID_TARGET", 400);
      }
    }

    if (target.resellerId) {
      const finalQuotas = {
        project: data.maxProjects !== undefined ? data.maxProjects : target.maxProjects,
        domain: data.maxDomains !== undefined ? data.maxDomains : target.maxDomains,
        database: data.maxDatabases !== undefined ? data.maxDatabases : target.maxDatabases,
        mailbox: data.maxMailboxes !== undefined ? data.maxMailboxes : target.maxMailboxes,
        scheduledTask: data.maxScheduledTasks !== undefined ? data.maxScheduledTasks : target.maxScheduledTasks,
        redisInstance: data.maxRedisInstances !== undefined ? data.maxRedisInstances : target.maxRedisInstances,
      };
      await assertNominalPoolWithinCap(
        this.prisma,
        target.resellerId,
        target.id,
        finalQuotas,
        (message, code, statusCode) => new UserError(message, code, statusCode),
      );
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: PUBLIC_USER_SELECT,
    });

    await this.auditLog.log(
      requester.id,
      "user.quotas_changed",
      { type: "User", id },
      {
        before: {
          maxProjects: target.maxProjects,
          maxDomains: target.maxDomains,
          maxDatabases: target.maxDatabases,
          maxMailboxes: target.maxMailboxes,
          maxSubAccounts: target.maxSubAccounts,
          maxScheduledTasks: target.maxScheduledTasks,
          maxRedisInstances: target.maxRedisInstances,
          ...(data.oversellingEnabled !== undefined ? { oversellingEnabled: target.oversellingEnabled } : {}),
        },
        after: data,
      },
    );

    return updated;
  }

  /**
   * ADMIN can delete any user (but not themselves); RESELLER can only
   * delete their own sub-accounts.
   */
  async delete(requester: Requester, id: string) {
    if (id === requester.id) {
      throw new UserError("You cannot delete your own account", "CANNOT_DELETE_SELF", 400);
    }

    const target = await this.ensureExists(id);
    this.assertCanManage(requester, target);

    // Redis teardown and session revocation run before the row is deleted;
    // if either fails the user is kept and the admin can retry — better than
    // a deleted account whose containers keep running (or whose login cookie
    // still works).
    await this.teardownRedisInstances?.(id);
    await this.revokeSessions?.(id);
    await this.prisma.user.delete({ where: { id } });

    this.onUserDeleted?.(id);

    await this.auditLog.log(
      requester.id,
      "user.deleted",
      { type: "User", id },
      { before: { email: target.email, role: target.role } },
    );
  }

  /**
   * ADMIN may manage anyone; RESELLER may only manage a USER they own
   * (their own sub-account) — never another reseller's account, an admin,
   * or a user that isn't theirs.
   */
  private assertCanManage(requester: Requester, target: { id: string; resellerId: string | null }) {
    if (requester.role === "ADMIN") return;

    if (target.resellerId !== requester.id) {
      throw new UserError("You can only manage your own sub-accounts", "FORBIDDEN", 403);
    }
  }

  /**
   * ADMIN creates a user of any role directly; RESELLER creates a USER
   * sub-account under themselves, gated by their own maxSubAccounts quota.
   */
  async createSubAccount(requester: Requester, data: CreateSubAccountInput) {
    const isAdmin = requester.role === "ADMIN";

    if (!isAdmin) {
      await assertUnderQuota(
        this.prisma,
        requester.id,
        "subAccount",
        (message, code, statusCode) => new UserError(message, code, statusCode),
      );
    }

    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new UserError("Email already registered", "EMAIL_EXISTS", 409);
    }

    const hashedPassword = await argon2.hash(data.password, { type: argon2.argon2id });

    const created = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: hashedPassword,
        role: isAdmin ? (data.role ?? "USER") : "USER",
        resellerId: isAdmin ? null : requester.id,
      },
      select: PUBLIC_USER_SELECT,
    });

    await this.auditLog.log(requester.id, "user.created", { type: "User", id: created.id }, {
      after: { email: created.email, role: created.role },
    });

    if (!isAdmin) void notifyQuotaThreshold(this.prisma, requester.id, "subAccount");

    return created;
  }

  private async ensureExists(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        resellerId: true,
        maxProjects: true,
        maxDomains: true,
        maxDatabases: true,
        maxMailboxes: true,
        maxSubAccounts: true,
        maxScheduledTasks: true,
        maxRedisInstances: true,
        permissions: true,
        oversellingEnabled: true,
      },
    });
    if (!user) {
      throw new UserError("User not found", "USER_NOT_FOUND", 404);
    }
    return user;
  }
}
