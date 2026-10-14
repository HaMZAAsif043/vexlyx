import type { Role } from "@prisma/client";

/**
 * Who may see and manage host services. Applied by both the HTTP routes
 * (`requireRole`) and the Socket.IO `subscribe:services` handler.
 */
export const SERVICES_ACCESS: { roles: Role[] } = {
  roles: ["ADMIN"],
};
