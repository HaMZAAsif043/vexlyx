import { z } from "zod";

export const SYSTEM_EMAIL_EVENTS = [
  "password_reset",
  "password_changed",
  "role_changed",
  "two_factor_enabled",
  "two_factor_disabled",
  "two_factor_reset",
  "quota_warning",
  "backup_failed",
  "scheduled_task_failed",
  "test",
] as const;
export type SystemEmailEvent = (typeof SYSTEM_EMAIL_EVENTS)[number];

export const SystemEmailTestSchema = z.object({
  to: z.string().email("Invalid email address"),
});
export type SystemEmailTestInput = z.infer<typeof SystemEmailTestSchema>;

export interface SystemEmailDnsRecord {
  type: string;
  name: string;
  /** Full host name to create the record at, e.g. default._domainkey.panel.example.com. */
  host: string;
  value: string;
  purpose: "SPF" | "DKIM" | "DMARC";
  /** Result of the live public-DNS lookup; null when not checked. */
  present: boolean | null;
}

export interface SystemEmailStatusResponse {
  enabled: boolean;
  /** "bundled" = the server's own Postfix; "external" = SMTP_* override. */
  transport: "bundled" | "external" | "log";
  from: string;
  domain: string;
  lastSentAt: string | null;
  lastError: string | null;
  dnsRecords: SystemEmailDnsRecord[];
}
