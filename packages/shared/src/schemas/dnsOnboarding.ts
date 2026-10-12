import { z } from "zod";

// ---------------------------------------------------------------------------
// DNS Records & Public IP Visibility (F5.9)
// ---------------------------------------------------------------------------

export const DnsRecordSuggestionSchema = z.object({
  type: z.enum(["A", "MX"]),
  host: z.string(),
  value: z.string(),
  priority: z.number().int().min(0).max(65535).optional(),
  // Human-readable note on what this record is for (panel, webmail,
  // deployed projects), shown alongside the record in the UI.
  purpose: z.string(),
});
export type DnsRecordSuggestion = z.infer<typeof DnsRecordSuggestionSchema>;

export const DnsOnboardingInfoSchema = z.object({
  // Null when the installer couldn't auto-detect a public IP (no outbound
  // internet and local route lookup failed) — the admin needs to fill it in.
  publicIp: z.string().nullable(),
  domain: z.string().nullable(),
  baseDomain: z.string(),
  records: z.array(DnsRecordSuggestionSchema),
});
export type DnsOnboardingInfoResponse = z.infer<typeof DnsOnboardingInfoSchema>;

// ---------------------------------------------------------------------------
// Live DNS verification for the records above (F5.11 UX follow-up) — lets an
// admin check "has this actually propagated yet?" from the Settings page
// instead of shelling out to `dig`.
// ---------------------------------------------------------------------------

export const DnsResolverCheckSchema = z.object({
  resolver: z.string(),
  status: z.enum(["MATCH", "MISMATCH", "NOT_FOUND", "ERROR"]),
  detectedValues: z.array(z.string()),
});
export type DnsResolverCheckResult = z.infer<typeof DnsResolverCheckSchema>;

export const DnsRecordVerificationSchema = z.object({
  type: z.enum(["A", "MX"]),
  host: z.string(),
  // The hostname actually queried — differs from `host` for a wildcard
  // record (`*.example.com`), since a literal `*` isn't resolvable; a probe
  // subdomain under the same zone is queried instead.
  checkedHost: z.string(),
  expected: z.string(),
  isPropagated: z.boolean(),
  resolvers: z.array(DnsResolverCheckSchema),
});
export type DnsRecordVerification = z.infer<typeof DnsRecordVerificationSchema>;

export const DnsVerificationResponseSchema = z.object({
  checkedAt: z.string().datetime(),
  results: z.array(DnsRecordVerificationSchema),
});
export type DnsVerificationResponse = z.infer<
  typeof DnsVerificationResponseSchema
>;
