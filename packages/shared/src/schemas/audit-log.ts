import { z } from "zod";
import { RoleSchema } from "./users.js";

// ---------------------------------------------------------------------------
// Known action strings (F5.18) — kept as a documented const array rather
// than a DB enum so new call sites never need a migration, while still
// giving callers autocomplete/typo-safety.
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  "user.role_changed",
  "user.quotas_changed",
  "user.permissions_changed",
  "user.created",
  "user.deleted",
  "firewall.rule_created",
  "firewall.rule_deleted",
  "firewall.policy_changed",
  "backup.restored",
  "backup.deleted",
  "file.permissions_changed",
  "file.archive_extracted",
  "file.archive_created",
  "project.created",
  "project.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "domain.dns_mode_changed",
  "database.created",
  "database.deleted",
  "redis_instance.created",
  "redis_instance.updated",
  "redis_instance.password_rotated",
  "redis_instance.deleted",
  "mailbox.created",
  "mailbox.deleted",
  "user.2fa_enabled",
  "user.2fa_disabled",
  "user.2fa_reset",
  "user.password_reset",
  "system_email.test_sent",
  "scheduled_task.created",
  "scheduled_task.updated",
  "scheduled_task.deleted",
  "scheduled_task.run_now",
  "github.app_created",
  "github.app_replaced",
  "github.installation_linked",
  "github.installation_unlinked",
  "github.installation_link_rejected",
  "github.project_connected",
  "github.project_disconnected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  actorEmail: z.string(),
  actorRole: RoleSchema,
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogListResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;

// ---------------------------------------------------------------------------
// Query (filters + pagination)
// ---------------------------------------------------------------------------

export const AuditLogQuerySchema = z.object({
  actorId: z.string().optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;
