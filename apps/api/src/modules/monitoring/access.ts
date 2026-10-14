import type { Role } from "@prisma/client";

/**
 * Who may read host-wide metrics (server, every container, history). Applied by
 * both the HTTP routes (`requireRole`) and the Socket.IO `metrics` room, so the
 * two cannot drift apart. These expose other tenants' containers and host
 * capacity, hence admin-only (#45).
 */
export const MONITORING_ACCESS: { roles: Role[] } = {
  roles: ["ADMIN"],
};
