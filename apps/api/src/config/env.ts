import { z } from "zod";

/**
 * Zod schema defining all required environment variables for the API server.
 * Validates types and provides sensible defaults for local development.
 */
const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(5000),
    HOST: z.string().min(1).default("0.0.0.0"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    CORS_ORIGIN: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    SESSION_SECRET: z.string().min(32),
    // Key for everything encrypted at rest (#69). Required in production so a
    // SESSION_SECRET leak cannot also decrypt stored credentials, and so
    // rotating SESSION_SECRET cannot silently orphan them. Outside production
    // it still falls back to SESSION_SECRET for zero-config local dev.
    ENCRYPTION_KEY: z.string().min(32).optional(),
    // Migration aid for installs that ran without ENCRYPTION_KEY: data was
    // encrypted under a key derived from SESSION_SECRET. With this on, that
    // key is accepted for *decryption* only (and, in production, a missing
    // ENCRYPTION_KEY does not stop boot). Run `pnpm db:reencrypt`, then unset.
    ENCRYPTION_KEY_LEGACY_FALLBACK: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Session cookie Domain attribute (F5.1). Needed whenever the dashboard
    // and API are served from different subdomains (e.g. panel.example.com /
    // api.panel.example.com) — without it, the cookie defaults to a host-only
    // scope on whichever origin set it, so the other subdomain's server-side
    // auth check never sees it. Leave unset for local dev (dashboard/api both
    // on localhost, where a Domain attribute doesn't apply the same way).
    COOKIE_DOMAIN: z.string().min(1).optional(),
    // Public self-registration is off by default (F5.8) — a fresh install is a
    // closed panel where the first admin (created by create-admin.ts/seed.ts)
    // provisions everyone else from /users. Flip to "true" to allow it.
    ALLOW_REGISTRATION: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    REQUIRE_ADMIN_2FA: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Git integration (F1.3)
    PROJECTS_DIR: z.string().min(1).default("./workspaces/projects"),
    SSH_KEYS_DIR: z.string().min(1).default("./workspaces/keys"),
    API_BASE_URL: z.string().url().default("http://localhost:5000"),
    // Build integration (F1.4)
    NIXPACKS_IMAGE_PREFIX: z.string().min(1).default("vexlyx"),
    BUILD_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
    // Deploy integration (F1.5)
    // Base domain used to generate per-project Traefik hostnames: {name}.{BASE_DOMAIN}
    BASE_DOMAIN: z.string().min(1).default("vexlyx.localhost"),
    // Default memory limit passed to Docker (e.g. 128m, 256m, 512m)
    DEPLOY_MEMORY_LIMIT: z.string().min(1).default("128m"),
    // Dynamic host-port range used when no project.port is set
    DEPLOY_PORT_RANGE_START: z.coerce.number().int().min(1024).default(8100),
    DEPLOY_PORT_RANGE_END: z.coerce.number().int().max(65535).default(8999),
    // Database Provisioning (F2.6)
    POSTGRES_CONTAINER_NAME: z.string().min(1).default("vexlyx-postgres"),
    POSTGRES_HOST: z.string().min(1).default("localhost"),
    POSTGRES_PORT: z.coerce.number().int().default(5432),
    POSTGRES_USER: z.string().min(1).default("vexlyx"),
    POSTGRES_PASSWORD: z.string().min(1).default("vexlyx_dev"),
    MYSQL_CONTAINER_NAME: z.string().min(1).default("vexlyx-mysql"),
    MYSQL_HOST: z.string().min(1).default("localhost"),
    MYSQL_PORT: z.coerce.number().int().default(3306),
    MYSQL_ROOT_USER: z.string().min(1).default("root"),
    MYSQL_ROOT_PASSWORD: z.string().min(1).default("vexlyx_mysql_root"),
    // Browser-facing Adminer URL. Local development gets a localhost default
    // below; production is disabled unless an administrator explicitly supplies
    // a secure public URL.
    ADMINER_URL: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.string().url().optional()),
    // Custom Domain Mock DNS (F3.1)
    VEXLYX_MOCK_DNS: z.string().optional(),
    // Email — Dovecot IMAP Server (F4.2)
    IMAP_HOST: z.string().min(1).default("127.0.0.1"),
    IMAP_PORT: z.coerce.number().int().default(143),
    IMAPS_PORT: z.coerce.number().int().default(993),
    // Webmail — Roundcube (F4.4)
    WEBMAIL_URL: z.string().default("http://localhost:8089"),
    WEBMAIL_PORT: z.coerce.number().int().default(8089),
    WEBMAIL_CONTAINER_NAME: z.string().min(1).default("vexlyx-roundcube"),
    // File Manager & SFTP (F2.8)
    FILE_UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(1000).default(1000),
    SFTP_HOST: z.string().min(1).default("0.0.0.0"),
    SFTP_PORT: z.coerce.number().int().default(22),
    // Backup System (F5.3) — these are only first-boot defaults for the
    // BackupSettings singleton row; once created, the DB row is authoritative.
    BACKUPS_DIR: z.string().min(1).default("./workspaces/backups"),
    BACKUP_SCHEDULE_CRON: z.string().min(1).default("0 3 * * *"),
    BACKUP_RETENTION_DAILY: z.coerce.number().int().min(1).default(7),
    BACKUP_RETENTION_WEEKLY: z.coerce.number().int().min(0).default(4),
    // Firewall management (F5.4). Ports that add_rule/delete_rule/
    // set_default_policy in firewall_manager.py refuse to lock out — see
    // system/scripts/install/steps/15-firewall.sh for the installer's own
    // (one-time) SSH-lockout guard this mirrors at runtime.
    FIREWALL_SSH_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    FIREWALL_HELPER_IMAGE: z
      .string()
      .min(1)
      .default("vexlyx-ufw-helper:latest"),
    // No-build PHP hosting (F5.21) — fixed PHP-FPM image (common extensions
    // baked in, see docker/php-fpm/Dockerfile) that composer-less PHP projects
    // deploy against instead of a per-project Nixpacks build.
    PHP_FPM_IMAGE: z.string().min(1).default("vexlyx-php-fpm:8.3"),
    // Service Status Dashboard (F5.6) — container names for the managed
    // services. POSTGRES_CONTAINER_NAME already exists above (F2.6); the rest
    // follow the same "configurable via env, sane default" convention.
    POSTFIX_CONTAINER_NAME: z.string().min(1).default("vexlyx-postfix"),
    DOVECOT_CONTAINER_NAME: z.string().min(1).default("vexlyx-dovecot"),
    COREDNS_CONTAINER_NAME: z.string().min(1).default("vexlyx-coredns"),
    REDIS_CONTAINER_NAME: z.string().min(1).default("vexlyx-redis"),
    // DNS Records & Public IP Onboarding (F5.9) — set by the installer in
    // production (docker-compose.prod.yml). PANEL_DOMAIN is VEXLYX_DOMAIN;
    // PUBLIC_IP is auto-detected by the installer and may be absent if
    // detection failed, in which case docker-compose.prod.yml still sets the
    // env var but to an empty string — coerce that to undefined rather than
    // failing validation. Both unset in local dev, where DNS onboarding is moot.
    PANEL_DOMAIN: z.string().min(1).optional(),
    HOSTED_MAIL_HOSTNAME: z.string().min(1).optional(),
    HOSTED_MAIL_DOMAIN: z.string().min(1).optional(),
    PUBLIC_IP: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    // Nameservers users delegate to when opting into "Managed" DNS (F5.23).
    DNS_NAMESERVERS: z
      .string()
      .default("ns1.vexlyx.com,ns2.vexlyx.com")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    // Python interpreter used to spawn system/python/*.py scripts (F5.14).
    // Defaults to "python" on win32 / "python3" elsewhere when unset — only
    // set this to override that default (e.g. a venv interpreter, or a
    // non-standard binary name/path on the host).
    PYTHON_BIN: z.string().min(1).optional(),
    // File Manager archive limits (F5.24) — zip-bomb / disk-fill guards for
    // extract and compress. Applied to the uncompressed size and entry count.
    FILE_ARCHIVE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(2 * 1024 * 1024 * 1024),
    FILE_ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).default(50_000),
    FILE_ARCHIVE_MAX_RATIO: z.coerce.number().min(1).default(100),
    // System transactional email (F5.23). With nothing set, panel mail is
    // sent as notifications@<MAIL_DOMAIN> through the bundled Postfix — no operator
    // configuration. EMAIL_SMTP_* point the same client at any external SMTP
    // relay instead (Resend, Postmark, SES, ...) for hosts that block
    // outbound port 25. Named EMAIL_SMTP_* (not SMTP_*) because SMTP_HOST/
    // SMTP_PORT are already read by the customer mail-hosting diagnostics.
    EMAIL_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    // Unset: "log" outside production (print mail to the API log), "smtp" in production.
    EMAIL_TRANSPORT: z.enum(["smtp", "log"]).optional(),
    MAIL_DOMAIN: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined)),
    MAIL_FROM: z.string().email().optional(),
    // Where replies go (the operator's inbox) — the sender itself has no mailbox.
    MAIL_REPLY_TO: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.string().email().optional()),
    BUNDLED_SMTP_HOST: z.string().min(1).default("127.0.0.1"),
    BUNDLED_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(25),
    EMAIL_SMTP_HOST: z.string().min(1).optional(),
    EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    EMAIL_SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    EMAIL_SMTP_USER: z.string().min(1).optional(),
    EMAIL_SMTP_PASS: z.string().min(1).optional(),
    // Admin accounts are root-equivalent on the host, so email-based reset is
    // off unless an operator explicitly opts in.
    ALLOW_ADMIN_EMAIL_RESET: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.EMAIL_TRANSPORT === "log") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message:
          "EMAIL_TRANSPORT=log prints mail (including reset links) to the log and is not allowed in production",
      });
    }
    if (value.NODE_ENV === "production") {
      if (!value.ENCRYPTION_KEY) {
        if (!value.ENCRYPTION_KEY_LEGACY_FALLBACK) {
          ctx.addIssue({
            code: "custom",
            path: ["ENCRYPTION_KEY"],
            message:
              "ENCRYPTION_KEY is required in production (generate one with `openssl rand -hex 32`). " +
              "Upgrading an install that never set it? Set ENCRYPTION_KEY_LEGACY_FALLBACK=true temporarily and run `pnpm db:reencrypt`",
          });
        }
      } else if (/change-?me/i.test(value.ENCRYPTION_KEY)) {
        ctx.addIssue({
          code: "custom",
          path: ["ENCRYPTION_KEY"],
          message: "ENCRYPTION_KEY is still the .env.example placeholder; generate a random value",
        });
      } else if (value.ENCRYPTION_KEY === value.SESSION_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["ENCRYPTION_KEY"],
          message: "ENCRYPTION_KEY must differ from SESSION_SECRET",
        });
      }
    }
    if (Boolean(value.EMAIL_SMTP_USER) !== Boolean(value.EMAIL_SMTP_PASS)) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_SMTP_USER"],
        message: "EMAIL_SMTP_USER and EMAIL_SMTP_PASS must be set together",
      });
    }
    if (value.NODE_ENV !== "production" || !value.ADMINER_URL) return;

    const url = new URL(value.ADMINER_URL);
    if (url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path: ["ADMINER_URL"],
        message: "ADMINER_URL must use HTTPS in production",
      });
    }
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ["ADMINER_URL"],
        message: "ADMINER_URL must not point to localhost in production",
      });
    }
  });

/**
 * Parses and validates environment variables against the Zod schema.
 * Throws a descriptive error on startup if any variables are invalid or missing.
 * @returns Typed, validated environment object
 * @throws Error with per-field messages if validation fails
 */
function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  const mailDomain =
    result.data.MAIL_DOMAIN ??
    result.data.PANEL_DOMAIN ??
    result.data.BASE_DOMAIN;

  return {
    ...result.data,
    EMAIL_TRANSPORT:
      result.data.EMAIL_TRANSPORT ??
      (result.data.NODE_ENV === "production"
        ? ("smtp" as const)
        : ("log" as const)),
    MAIL_DOMAIN: mailDomain,
    MAIL_FROM: result.data.MAIL_FROM ?? `notifications@${mailDomain}`,
    ADMINER_URL:
      result.data.ADMINER_URL ??
      (result.data.NODE_ENV === "development"
        ? "http://localhost:8088"
        : undefined),
  };
}

/** Inferred TypeScript type from the environment schema */
export type Env = ReturnType<typeof validateEnv>;

/** Validated environment variables — safe to use throughout the API */
export const env = validateEnv();
