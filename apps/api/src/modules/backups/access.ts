import type { Permission, Role } from "@prisma/client";

/**
 * Who may use backups. This single rule is applied by both the HTTP routes
 * (`requireRoleOrPermission`) and the Socket.IO `subscribe:backups` handler, so
 * the two paths cannot drift apart.
 */
export const BACKUPS_ACCESS: { roles: Role[]; permission: Permission } = {
  roles: ["ADMIN"],
  permission: "canManageBackups",
};
