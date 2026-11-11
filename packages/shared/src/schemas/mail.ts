import { z } from "zod";
import { DnsModeSchema } from "./domains.js";

/**
 * Schema validating Dovecot IMAP server diagnostics and service status.
 */
export const ImapStatusSchema = z.object({
  service: z.literal("dovecot"),
  status: z.enum(["active", "inactive", "error"]),
  port143Open: z.boolean(),
  port993Open: z.boolean(),
  tlsEnforced: z.boolean(),
  saslAuthConnected: z.boolean(),
  activeMailboxesCount: z.number().int().nonnegative(),
  lastChecked: z.string(),
});

export type ImapStatusResponse = z.infer<typeof ImapStatusSchema>;

/**
 * Schema validating SMTP server diagnostics and service status.
 */
export const SmtpStatusSchema = z.object({
  service: z.literal("postfix"),
  status: z.enum(["active", "inactive", "error"]),
  port25Open: z.boolean(),
  port587Open: z.boolean(),
  tlsEnforced: z.boolean(),
  openRelayProtected: z.boolean(),
  openDkimConnected: z.boolean(),
  activeVirtualDomainsCount: z.number().int().nonnegative(),
  queueCount: z.number().int().nonnegative(),
  lastChecked: z.string(),
  /** Dovecot IMAP status (F4.2), attached alongside SMTP status for a single combined mail health check. */
  imap: ImapStatusSchema.optional(),
});

export type SmtpStatusResponse = z.infer<typeof SmtpStatusSchema>;

/**
 * Schema validating DKIM public key and DNS TXT record details.
 */
export const DkimRecordSchema = z.object({
  domain: z.string(),
  selector: z.string().default("default"),
  dnsRecordName: z.string(),
  dnsRecordValue: z.string(),
  publicKey: z.string(),
  keyLength: z.number().int().default(2048),
  inDns: z.boolean().default(false),
});

export type DkimRecordResponse = z.infer<typeof DkimRecordSchema>;

/**
 * Schema for a single deliverability check (SPF/DKIM/DMARC/MX) result.
 */
export const MailAuthCheckSchema = z.object({
  pass: z.boolean(),
  detail: z.string(),
});

export type MailAuthCheck = z.infer<typeof MailAuthCheckSchema>;

/**
 * A record a CONNECTED domain's owner must publish at their own registrar.
 * `live` is true when public DNS already serves a record for that purpose.
 */
export const RequiredMailRecordSchema = z.object({
  purpose: z.enum(["MX", "HOST", "SPF", "DKIM", "DMARC"]),
  type: z.enum(["TXT", "MX", "A"]),
  name: z.string(),
  value: z.string(),
  priority: z.number().int().optional(),
  live: z.boolean(),
});

export type RequiredMailRecordResponse = z.infer<typeof RequiredMailRecordSchema>;

/**
 * Schema for an internal-only 0-100 email deliverability scorecard (F4.5).
 * MANAGED domains score from Vexlyx's own DnsRecord table; CONNECTED domains
 * score from live public DNS lookups (F5.26).
 */
export const MailAuthStatusSchema = z.object({
  domainId: z.string(),
  hostname: z.string(),
  dnsMode: DnsModeSchema,
  requiredRecords: z.array(RequiredMailRecordSchema).optional(),
  spfConfigured: z.boolean(),
  dkimConfigured: z.boolean(),
  dmarcConfigured: z.boolean(),
  mxConfigured: z.boolean(),
  score: z.number().int().min(0).max(100),
  grade: z.enum(["Excellent", "Good", "Needs Improvement", "Poor"]),
  checks: z.object({
    spf: MailAuthCheckSchema,
    dkim: MailAuthCheckSchema,
    dmarc: MailAuthCheckSchema,
    mx: MailAuthCheckSchema,
  }),
});

export type MailAuthStatusResponse = z.infer<typeof MailAuthStatusSchema>;

/**
 * Schema for a virtual domain registered with Postfix.
 */
export const VirtualDomainSchema = z.object({
  domainId: z.string(),
  hostname: z.string(),
  status: z.string(),
  dnsMode: DnsModeSchema,
  requiredRecords: z.array(RequiredMailRecordSchema).optional(),
  dkimEnabled: z.boolean(),
  dkimRecord: DkimRecordSchema.optional(),
  mailboxCount: z.number().int().default(0),
  spfConfigured: z.boolean().default(false),
  dmarcConfigured: z.boolean().default(false),
  mxConfigured: z.boolean().default(false),
  deliverabilityScore: z.number().int().min(0).max(100).default(0),
  deliverabilityGrade: z
    .enum(["Excellent", "Good", "Needs Improvement", "Poor"])
    .default("Poor"),
  authChecks: z
    .object({
      spf: MailAuthCheckSchema,
      dkim: MailAuthCheckSchema,
      dmarc: MailAuthCheckSchema,
      mx: MailAuthCheckSchema,
    })
    .optional(),
});

export type VirtualDomain = z.infer<typeof VirtualDomainSchema>;

/**
 * Values that end up in the SMTP DATA header block must not carry line
 * breaks: a CRLF in the subject appends arbitrary headers and SMTP commands.
 */
const noLineBreaks = (field: string) =>
  z.string().refine((val) => !/[\r\n]/.test(val), {
    message: `${field} cannot contain line breaks`,
  });

/**
 * Schema validating test email delivery requests.
 */
export const SendTestEmailSchema = z.object({
  from: z.string().email("Invalid sender email address"),
  to: z.string().email("Invalid recipient email address"),
  subject: noLineBreaks("Subject")
    .pipe(z.string().min(1, "Subject is required"))
    .default("Vexlyx SMTP Diagnostics Test"),
  body: z
    .string()
    .min(1, "Body is required")
    .default("This is an automated test email sent via Vexlyx Postfix SMTP service to verify TLS and DKIM."),
  port: z.union([z.literal(25), z.literal(587)]).default(587),
  useTls: z.boolean().default(true),
  username: noLineBreaks("Username").optional(),
  password: z.string().optional(),
});

export type SendTestEmailInput = z.infer<typeof SendTestEmailSchema>;

/**
 * Schema representing the result of an SMTP test delivery attempt.
 */
export const TestEmailResultSchema = z.object({
  success: z.boolean(),
  messageId: z.string().nullable(),
  transcript: z.array(z.string()),
  error: z.string().nullable(),
  tlsVersion: z.string().optional(),
  cipherSuite: z.string().optional(),
});

export type TestEmailResultResponse = z.infer<typeof TestEmailResultSchema>;

/**
 * Schema validating Roundcube webmail container status.
 */
export const WebmailStatusSchema = z.object({
  service: z.literal("roundcube"),
  status: z.enum(["active", "inactive", "error"]),
  containerRunning: z.boolean(),
  url: z.string(),
  lastChecked: z.string(),
});

export type WebmailStatusResponse = z.infer<typeof WebmailStatusSchema>;

/**
 * Schema for synchronizing virtual domains from database to Postfix.
 */
export const SyncVirtualDomainsSchema = z.object({
  domains: z.array(z.string()).min(0),
});

export type SyncVirtualDomainsInput = z.infer<typeof SyncVirtualDomainsSchema>;

/**
 * Schema for a single message in the Postfix mail queue (F4.8).
 */
export const QueueMessageSchema = z.object({
  queueId: z.string(),
  flagged: z.enum(["active", "held", "none"]),
  sizeBytes: z.number().int().nonnegative(),
  arrivalTime: z.string(),
  sender: z.string(),
  recipients: z.array(z.string()),
  reason: z.string().nullable(),
});

export type QueueMessage = z.infer<typeof QueueMessageSchema>;

/**
 * Schema validating the full Postfix mail queue listing (F4.8).
 */
export const QueueListResponseSchema = z.object({
  messages: z.array(QueueMessageSchema),
  totalCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  lastChecked: z.string(),
});

export type QueueListResponse = z.infer<typeof QueueListResponseSchema>;

/**
 * Schema for the result of a queue action (delete/flush/hold/release) (F4.8).
 */
export const QueueActionResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type QueueActionResult = z.infer<typeof QueueActionResultSchema>;

/**
 * Schema for a single Postfix delivery/bounce log entry (F4.8).
 */
export const DeliveryLogEntrySchema = z.object({
  timestamp: z.string(),
  queueId: z.string(),
  sender: z.string().nullable(),
  recipient: z.string(),
  status: z.enum(["success", "deferred", "bounced"]),
  relay: z.string().nullable(),
  delay: z.string().nullable(),
  reason: z.string().nullable(),
});

export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntrySchema>;

/**
 * Schema validating a delivery log query result (F4.8).
 */
export const DeliveryLogResponseSchema = z.object({
  entries: z.array(DeliveryLogEntrySchema),
  truncated: z.boolean(),
});

export type DeliveryLogResponse = z.infer<typeof DeliveryLogResponseSchema>;

/**
 * Schema validating delivery log filter/query parameters (F4.8).
 */
export const DeliveryLogFilterSchema = z.object({
  domain: z.string().optional(),
  mailbox: z.string().optional(),
  status: z.enum(["success", "deferred", "bounced"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export type DeliveryLogFilterInput = z.infer<typeof DeliveryLogFilterSchema>;

/**
 * Lifecycle status of a DKIM key (F4.8). ACTIVE signs new outgoing mail;
 * RETIRING is a previously-active key kept valid in DNS during rotation
 * propagation; RETIRED means an admin has confirmed it can be removed.
 */
export const DkimKeyStatusSchema = z.enum(["ACTIVE", "RETIRING", "RETIRED"]);

/**
 * Schema for a single tracked DKIM selector/key (F4.8).
 */
export const DkimKeySchema = z.object({
  id: z.string(),
  domainId: z.string(),
  selector: z.string(),
  status: DkimKeyStatusSchema,
  publicKey: z.string(),
  keyLength: z.number().int(),
  createdAt: z.string(),
  retiredAt: z.string().nullable(),
});

export type DkimKey = z.infer<typeof DkimKeySchema>;

/**
 * Schema validating the result of a DKIM key rotation (F4.8).
 */
export const DkimRotateResponseSchema = z.object({
  domain: z.string(),
  newKey: DkimRecordSchema,
  retiringKey: z.object({
    selector: z.string(),
    dnsRecordName: z.string(),
  }),
  keys: z.array(DkimKeySchema),
});

export type DkimRotateResponse = z.infer<typeof DkimRotateResponseSchema>;

/**
 * Schema for a single mailbox's Roundcube login activity (F4.8).
 */
export const WebmailLoginActivitySchema = z.object({
  address: z.string(),
  lastLogin: z.string().nullable(),
});

export type WebmailLoginActivity = z.infer<typeof WebmailLoginActivitySchema>;

/**
 * Schema validating recent Roundcube login activity across a user's mailboxes (F4.8).
 */
export const WebmailActivityResponseSchema = z.object({
  logins: z.array(WebmailLoginActivitySchema),
  checkedAt: z.string(),
});

export type WebmailActivityResponse = z.infer<typeof WebmailActivityResponseSchema>;
