import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(["ADMIN", "USER", "RESELLER"]);
export type RoleInput = z.infer<typeof RoleSchema>;

// Named capabilities (F5.19) grantable on top of a role. Additive only — a
// permission never removes what a user's role already grants them.
export const PermissionSchema = z.enum([
  "canManageDns",
  "canManageFirewall",
  "canManageBackups",
  "canCreateSubAccounts",
]);
export type Permission = z.infer<typeof PermissionSchema>;

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  resellerId: z.string().nullable(),
  maxProjects: z.number().int().nullable(),
  maxDomains: z.number().int().nullable(),
  maxDatabases: z.number().int().nullable(),
  maxMailboxes: z.number().int().nullable(),
  maxSubAccounts: z.number().int().nullable(),
  maxScheduledTasks: z.number().int().nullable(),
  permissions: z.array(PermissionSchema),
  // Reseller-only (F5.20); always present but only meaningful when role is
  // RESELLER. ADMIN-only to change.
  oversellingEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const QuotaUsageSchema = z.object({
  used: z.number().int(),
  limit: z.number().int().nullable(),
  // Reseller-only (F5.20): populated on the project/domain/database/mailbox
  // entries of a reseller's own usage summary. nominalSum is the sum of all
  // sub-accounts' quota for that resource (null = at least one sub-account
  // is unlimited). oversold is true when that nominal sum exceeds `limit`.
  nominalSum: z.number().int().nullable().optional(),
  oversold: z.boolean().optional(),
});
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

export const UsageSummarySchema = z.object({
  project: QuotaUsageSchema,
  domain: QuotaUsageSchema,
  database: QuotaUsageSchema,
  mailbox: QuotaUsageSchema,
  subAccount: QuotaUsageSchema,
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateSubAccountSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
  // Only honored when the requester is ADMIN — a RESELLER-created account is
  // always forced to USER regardless of what's sent here.
  role: RoleSchema.optional(),
});
export type CreateSubAccountInput = z.infer<typeof CreateSubAccountSchema>;

export const UpdateUserRoleSchema = z.object({
  role: RoleSchema,
});
export type UpdateUserRoleInput = z.infer<typeof UpdateUserRoleSchema>;

const nullableQuota = z.number().int().min(0).nullable();

export const UpdateUserQuotasSchema = z.object({
  maxProjects: nullableQuota.optional(),
  maxDomains: nullableQuota.optional(),
  maxDatabases: nullableQuota.optional(),
  maxMailboxes: nullableQuota.optional(),
  maxSubAccounts: nullableQuota.optional(),
  // Scheduled tasks (F5.28).
  maxScheduledTasks: nullableQuota.optional(),
  // Reseller-only (F5.20); ADMIN-only to set (enforced in the service, not
  // here, since that depends on who the requester is).
  oversellingEnabled: z.boolean().optional(),
});
export type UpdateUserQuotasInput = z.infer<typeof UpdateUserQuotasSchema>;

export const UpdateUserPermissionsSchema = z.object({
  permissions: z.array(PermissionSchema),
});
export type UpdateUserPermissionsInput = z.infer<typeof UpdateUserPermissionsSchema>;
