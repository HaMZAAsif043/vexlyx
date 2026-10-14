import type { Permission, PrismaClient, Role } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Socket } from "socket.io";

/**
 * Who may join a privileged Socket.IO room. This mirrors the HTTP guards:
 * `roles` is `requireRole(...)`, and adding `permission` makes it
 * `requireRoleOrPermission(roles, permission)` (a listed role OR the
 * individually granted permission).
 */
export interface SocketAccessRule {
  roles: Role[];
  permission?: Permission;
}

export type SocketAuthorizer = (
  userId: string | undefined,
  rule: SocketAccessRule,
) => Promise<boolean>;

/**
 * Builds an authorizer that reads the role/permissions fresh from the database
 * on every call — the same source the HTTP guards use — so a revoked role or
 * permission takes effect on the next subscribe, not at the next login.
 *
 * Fails closed: a missing identity, an unknown user or a lookup error all deny.
 */
export function createSocketAuthorizer(
  prisma: PrismaClient,
  logger: Pick<FastifyBaseLogger, "error">,
): SocketAuthorizer {
  return async (userId, rule) => {
    if (!userId) return false;

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, permissions: true },
      });
      if (!user) return false;

      return (
        rule.roles.includes(user.role) ||
        (rule.permission !== undefined && user.permissions.includes(rule.permission))
      );
    } catch (err) {
      logger.error({ err, userId }, "Socket authorization lookup failed; denying");
      return false;
    }
  };
}

/**
 * Orders overlapping subscribe/unsubscribe requests on one socket.
 *
 * A subscribe awaits the authorization lookup; if the client leaves the page
 * meanwhile, `unsubscribe` (or disconnect) runs first and the late subscribe
 * must not then join the room or restart its timers. `begin()` hands out a
 * token and `cancel()` invalidates every outstanding one.
 */
export class SubscriptionGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

/**
 * Authorizes the socket against `rule`. When denied, tells the client why on
 * `deniedEvent` (so the UI can react) and returns false; the caller must then
 * skip joining the room.
 */
export async function authorizeSocketSubscription(
  authorize: SocketAuthorizer,
  socket: Pick<Socket, "data" | "emit">,
  rule: SocketAccessRule,
  deniedEvent: string,
): Promise<boolean> {
  const userId = socket.data.userId as string | undefined;
  if (await authorize(userId, rule)) return true;

  socket.emit(deniedEvent, {
    error: "You do not have permission to perform this action",
    code: "FORBIDDEN_ROLE",
    details: {},
  });
  return false;
}
