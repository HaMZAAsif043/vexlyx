import { spawn } from "node:child_process";
import { reconcileMailState, MailStateSyncError } from "./state-sync.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type {
  SmtpStatusResponse,
  ImapStatusResponse,
  WebmailStatusResponse,
  DkimRecordResponse,
  VirtualDomain,
  SendTestEmailInput,
  TestEmailResultResponse,
  MailAuthCheck,
  MailAuthStatusResponse,
  QueueListResponse,
  QueueActionResult,
  DeliveryLogResponse,
  DeliveryLogFilterInput,
  DkimKey,
  DkimRotateResponse,
  WebmailActivityResponse,
  RequiredMailRecordResponse,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { DnsService } from "../domains/dns-service.js";
import { getServerIp } from "../domains/resolvers.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import type { FastifyBaseLogger } from "fastify";
import {
  PYTHON_SCRIPT_TIMEOUT_MS,
  watchChildTimeout,
} from "../../utils/processWatchdog.js";
import {
  buildRequiredMailRecords,
  isRecordLive,
  lookupLiveMailRecords,
} from "./required-records.js";

export class MailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MailError";
  }
}

/**
 * True when `senderDomain` is an owned hostname or a subdomain of one (mail
 * often uses `mail.example.com` under the `example.com` domain record).
 * Wildcard domain records own their subdomains.
 */
export function senderBelongsToDomains(
  senderDomain: string,
  ownedHostnames: string[],
): boolean {
  const sender = senderDomain.toLowerCase();
  return ownedHostnames.some((hostname) => {
    const owned = hostname.toLowerCase().replace(/^\*\./, "");
    return sender === owned || sender.endsWith(`.${owned}`);
  });
}

function getPostfixManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/postfix_manager.py"),
    resolve(currentDir, "../../../../system/python/postfix_manager.py"),
    resolve(process.cwd(), "../../system/python/postfix_manager.py"),
    resolve(process.cwd(), "system/python/postfix_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return (
    candidates[0] ?? resolve(process.cwd(), "system/python/postfix_manager.py")
  );
}

function getDovecotManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/dovecot_manager.py"),
    resolve(currentDir, "../../../../system/python/dovecot_manager.py"),
    resolve(process.cwd(), "../../system/python/dovecot_manager.py"),
    resolve(process.cwd(), "system/python/dovecot_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return (
    candidates[0] ?? resolve(process.cwd(), "system/python/dovecot_manager.py")
  );
}

function getWebmailManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/webmail_manager.py"),
    resolve(currentDir, "../../../../system/python/webmail_manager.py"),
    resolve(process.cwd(), "../../system/python/webmail_manager.py"),
    resolve(process.cwd(), "system/python/webmail_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return (
    candidates[0] ?? resolve(process.cwd(), "system/python/webmail_manager.py")
  );
}

function getPythonExe(): string {
  if (process.env.PYTHON_PATH && existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }
  if (process.platform === "win32") {
    const candidates = [
      resolve(process.cwd(), "Python/pythoncore-3.14-64/python.exe"),
      resolve(process.cwd(), "apps/api/Python/pythoncore-3.14-64/python.exe"),
      resolve(
        process.cwd(),
        "../../apps/api/Python/pythoncore-3.14-64/python.exe",
      ),
      resolve(
        process.env.LOCALAPPDATA || "",
        "Python/pythoncore-3.14-64/python.exe",
      ),
      resolve(
        process.env.USERPROFILE || "",
        "AppData/Local/Python/pythoncore-3.14-64/python.exe",
      ),
    ];
    for (const c of candidates) {
      if (c && existsSync(c)) {
        return c;
      }
    }
  }
  return getPythonBin();
}

export async function runPostfixManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getPostfixManagerScriptPath();
  const pythonExe = getPythonExe();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn postfix_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `postfix_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function runDovecotManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getDovecotManagerScriptPath();
  const pythonExe = getPythonExe();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn dovecot_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `dovecot_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function runWebmailManager<T = Record<string, unknown>>(
  command: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const scriptPath = getWebmailManagerScriptPath();
  const pythonExe = getPythonExe();

  return new Promise((res, rej) => {
    const child = spawn(pythonExe, [scriptPath, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.mail, (ms) =>
      rej(
        new MailError(
          `Mail manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      rej(
        new MailError(
          `Failed to spawn webmail_manager: ${err.message}`,
          "SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        rej(
          new MailError(
            `webmail_manager failed (code ${code}): ${stderr}`,
            "PROCESS_ERROR",
            500,
          ),
        );
        return;
      }

      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const failure = parsed as Record<string, unknown>;
          rej(
            new MailError(
              typeof failure.error === "string"
                ? failure.error
                : "Mail synchronization failed",
              typeof failure.code === "string"
                ? failure.code
                : "MAIL_SYNC_FAILED",
              503,
              failure.details && typeof failure.details === "object"
                ? (failure.details as Record<string, unknown>)
                : {},
            ),
          );
          return;
        }
        if (code !== 0) {
          rej(
            new MailError(
              "The mail service operation did not complete.",
              "MAIL_PROCESS_ERROR",
              503,
            ),
          );
          return;
        }
        res(parsed as T);
      } catch {
        rej(
          new MailError(
            `Failed to parse manager response: ${stdout}`,
            "PARSE_ERROR",
            500,
          ),
        );
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export async function synchronizeMailState(prisma: PrismaClient) {
  const readSnapshot = async () => {
    const [domains, aliases] = await prisma.$transaction(
      [
        prisma.domain.findMany({
          select: {
            hostname: true,
            userId: true,
            mailboxes: {
              select: { address: true, password: true, quota: true },
            },
          },
        }),
        prisma.virtualAlias.findMany({
          select: { source: true, destinations: true, userId: true },
        }),
      ],
      { isolationLevel: "RepeatableRead" },
    );
    return { domains, aliases };
  };
  let synchronized: Awaited<ReturnType<typeof readSnapshot>> | undefined;
  try {
    await reconcileMailState(
      getPythonExe(),
      getPostfixManagerScriptPath(),
      async () => {
        synchronized = await readSnapshot();
        return {
          domains: synchronized.domains.map((domain) => domain.hostname),
          mailboxes: synchronized.domains.flatMap((domain) =>
            domain.mailboxes.map((mailbox) => ({
              address: mailbox.address,
              passwordHash: mailbox.password,
              quotaMb: mailbox.quota,
            })),
          ),
          aliases: synchronized.aliases.map((alias) => ({
            source: alias.source,
            destinations: alias.destinations,
          })),
        };
      },
    );
  } catch (error) {
    if (error instanceof MailStateSyncError)
      throw new MailError(error.message, error.code, 503, error.details);
    throw error;
  }
  if (!synchronized)
    throw new MailError(
      "Mail synchronization did not read a database snapshot.",
      "MAIL_SYNC_PROTOCOL_ERROR",
      503,
    );
  return synchronized;
}

export class MailService {
  private readonly dnsService: DnsService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {
    this.dnsService = new DnsService(prisma, logger);
  }

  /**
   * Probes and returns Postfix SMTP + OpenDKIM and Dovecot IMAP service health.
   */
  async getStatus(): Promise<SmtpStatusResponse> {
    const smtpHost = process.env.SMTP_HOST || "127.0.0.1";
    const imapHost = process.env.IMAP_HOST || "127.0.0.1";

    const [smtpResult, imapResult] = await Promise.all([
      runPostfixManager<SmtpStatusResponse>("status", { host: smtpHost }),
      runDovecotManager<ImapStatusResponse>("status", { host: imapHost }).catch(
        () => undefined,
      ),
    ]);

    return { ...smtpResult, imap: imapResult };
  }

  /**
   * Picks the records the deliverability scorecard is computed from. MANAGED
   * domains use their own DnsRecord rows; CONNECTED domains have no zone here,
   * so their scorecard comes from live public DNS and they get the list of
   * records to publish at their registrar (F5.26).
   */
  private async resolveAuthRecords(
    domain: {
      hostname: string;
      dnsMode: "CONNECTED" | "MANAGED";
      dnsRecords: Array<{
        type: string;
        name: string;
        value: string;
        priority: number | null;
      }>;
    },
    activeSelector: string,
    dkimValue: string | undefined,
  ): Promise<{
    records: Array<{
      type: string;
      name: string;
      value: string;
      priority: number | null;
    }>;
    requiredRecords?: RequiredMailRecordResponse[];
  }> {
    if (domain.dnsMode === "MANAGED") return { records: domain.dnsRecords };

    const required = buildRequiredMailRecords(
      domain.hostname,
      getServerIp(),
      dkimValue ? { selector: activeSelector, value: dkimValue } : undefined,
    );
    const live = await lookupLiveMailRecords(domain.hostname, required);
    return {
      records: live,
      requiredRecords: required.map((r) => ({
        ...r,
        live: isRecordLive(r, live),
      })),
    };
  }

  /**
   * Retrieves all virtual domains for a user, checking their DKIM signing keys and DNS setup.
   */
  async listVirtualDomains(userId: string): Promise<VirtualDomain[]> {
    const domains = await this.prisma.domain.findMany({
      where: { userId },
      include: {
        mailboxes: true,
        dnsRecords: {
          where: {
            OR: [
              // Any selector's DKIM TXT record — not just "default" — so a
              // rotated domain's currently-active selector is still found
              // (F4.8).
              { type: "TXT", name: { endsWith: "_domainkey" } },
              { type: "TXT", name: "@" },
              { type: "TXT", name: "_dmarc" },
              { type: "MX", name: "@" },
            ],
          },
        },
      },
      orderBy: { hostname: "asc" },
    });

    // Batch-fetch each domain's currently-active DKIM selector (F4.8
    // rotation) up front, so domains never rotated fall back to "default".
    const activeDkimKeys = await this.prisma.dkimKey.findMany({
      where: { domainId: { in: domains.map((d) => d.id) }, status: "ACTIVE" },
      select: { domainId: true, selector: true },
    });
    const activeSelectorByDomainId = new Map(
      activeDkimKeys.map((k) => [k.domainId, k.selector]),
    );

    const result: VirtualDomain[] = [];

    for (const d of domains) {
      const activeSelector = activeSelectorByDomainId.get(d.id) ?? "default";

      // Check existing DKIM record from python manager
      const dkim = await runPostfixManager<{
        found: boolean;
        domain: string;
        selector: string;
        dnsRecordName: string;
        dnsRecordValue: string;
        publicKey: string;
      }>("get_dkim", { domain: d.hostname, selector: activeSelector });

      const { records, requiredRecords } = await this.resolveAuthRecords(
        d,
        activeSelector,
        dkim.found ? dkim.dnsRecordValue : undefined,
      );
      const hasDnsTxt = records.some(
        (r) => r.type === "TXT" && r.name === `${activeSelector}._domainkey`,
      );

      const { checks, score, grade } = this.computeAuthChecks(
        records,
        activeSelector,
      );

      result.push({
        domainId: d.id,
        hostname: d.hostname,
        status: d.status,
        dnsMode: d.dnsMode,
        requiredRecords,
        dkimEnabled: dkim.found,
        dkimRecord: dkim.found
          ? {
              domain: dkim.domain,
              selector: dkim.selector,
              dnsRecordName: dkim.dnsRecordName,
              dnsRecordValue: dkim.dnsRecordValue,
              publicKey: dkim.publicKey,
              keyLength: 2048,
              inDns: hasDnsTxt,
            }
          : undefined,
        mailboxCount: d.mailboxes.length,
        spfConfigured: checks.spf.pass,
        dmarcConfigured: checks.dmarc.pass,
        mxConfigured: checks.mx.pass,
        deliverabilityScore: score,
        deliverabilityGrade: grade,
        authChecks: checks,
      });
    }

    return result;
  }

  /**
   * Pure, I/O-free computation of the F4.5 internal-only deliverability
   * scorecard from an already-fetched set of DNS records. No external DNS
   * lookups or third-party API calls are made — callers pass in either
   * Vexlyx's own DnsRecord rows (MANAGED) or already-resolved live records
   * (CONNECTED, see resolveAuthRecords).
   */
  private computeAuthChecks(
    dnsRecords: Array<{
      type: string;
      name: string;
      value: string;
      priority: number | null;
    }>,
    activeDkimSelector: string = "default",
  ): {
    checks: {
      spf: MailAuthCheck;
      dkim: MailAuthCheck;
      dmarc: MailAuthCheck;
      mx: MailAuthCheck;
    };
    score: number;
    grade: MailAuthStatusResponse["grade"];
  } {
    const unquote = (value: string) => value.replace(/^"|"$/g, "").trim();

    const spfRecord = dnsRecords.find(
      (r) =>
        r.type === "TXT" &&
        r.name === "@" &&
        unquote(r.value).startsWith("v=spf1"),
    );
    const dmarcRecord = dnsRecords.find(
      (r) =>
        r.type === "TXT" &&
        r.name === "_dmarc" &&
        unquote(r.value).startsWith("v=DMARC1"),
    );
    const dkimRecord = dnsRecords.find(
      (r) => r.type === "TXT" && r.name === `${activeDkimSelector}._domainkey`,
    );
    const mxRecord = dnsRecords.find((r) => r.type === "MX" && r.name === "@");

    const spfValid =
      !!spfRecord &&
      /^v=spf1(\s+\S+)*\s+[-~?]all$/.test(unquote(spfRecord.value));
    const dmarcValid =
      !!dmarcRecord &&
      /^v=DMARC1;\s*p=(none|quarantine|reject)/.test(
        unquote(dmarcRecord.value),
      );
    const dkimPublished = !!dkimRecord;
    const mxPresent = !!mxRecord;

    const checks = {
      spf: {
        pass: spfValid,
        detail: spfRecord
          ? unquote(spfRecord.value)
          : "No SPF TXT record found at @",
      },
      dkim: {
        pass: dkimPublished,
        detail: dkimPublished
          ? `${activeDkimSelector}._domainkey TXT record present`
          : "DKIM not published to DNS",
      },
      dmarc: {
        pass: dmarcValid,
        detail: dmarcRecord
          ? unquote(dmarcRecord.value)
          : "No DMARC TXT record found at _dmarc",
      },
      mx: {
        pass: mxPresent,
        detail: mxRecord
          ? `${mxRecord.value} (priority ${mxRecord.priority})`
          : "No MX record found",
      },
    };

    const score =
      (checks.spf.pass ? 25 : 0) +
      (checks.dkim.pass ? 25 : 0) +
      (checks.dmarc.pass ? 25 : 0) +
      (checks.mx.pass ? 25 : 0);

    const grade: MailAuthStatusResponse["grade"] =
      score === 100
        ? "Excellent"
        : score >= 75
          ? "Good"
          : score >= 50
            ? "Needs Improvement"
            : "Poor";

    return { checks, score, grade };
  }

  /**
   * Computes the F4.5 deliverability scorecard for a single domain.
   */
  async getMailAuthStatus(
    userId: string,
    domainId: string,
  ): Promise<MailAuthStatusResponse> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
      include: { dnsRecords: true },
    });

    if (!domain) {
      throw new MailError(
        "Domain not found or unauthorized",
        "DOMAIN_NOT_FOUND",
        404,
      );
    }

    const activeDkimKey = await this.prisma.dkimKey.findFirst({
      where: { domainId, status: "ACTIVE" },
      select: { selector: true },
    });

    const selector = activeDkimKey?.selector ?? "default";
    const dkimValue =
      domain.dnsMode === "CONNECTED"
        ? await this.connectedDomainDkimValue(
            domain.hostname,
            selector,
            activeDkimKey !== null,
          )
        : undefined;

    const { records, requiredRecords } = await this.resolveAuthRecords(
      domain,
      selector,
      dkimValue,
    );
    const { checks, score, grade } = this.computeAuthChecks(records, selector);

    return {
      domainId: domain.id,
      hostname: domain.hostname,
      dnsMode: domain.dnsMode,
      requiredRecords,
      spfConfigured: checks.spf.pass,
      dkimConfigured: checks.dkim.pass,
      dmarcConfigured: checks.dmarc.pass,
      mxConfigured: checks.mx.pass,
      score,
      grade,
      checks,
    };
  }

  /**
   * The DKIM TXT value a CONNECTED domain has to publish. A domain that has no
   * key yet gets one on its first check, so the record is listed with MX, SPF
   * and DMARC instead of appearing only after "regenerate" (#159).
   *
   * The key is read first and created only when absent: generate_dkim returns
   * an existing key unchanged (it never rotates), but it also rewrites
   * OpenDKIM's tables and signals it, which a check that the dashboard polls
   * should not do. A domain whose active selector came from a rotation is only
   * ever read: a missing key file there is a fault to surface, not a reason to
   * invent a different key under that selector.
   */
  private async connectedDomainDkimValue(
    hostname: string,
    selector: string,
    selectorFromRotation: boolean,
  ): Promise<string | undefined> {
    const existing = await runPostfixManager<{
      found: boolean;
      dnsRecordValue: string;
    }>("get_dkim", { domain: hostname, selector });
    if (existing.found) return existing.dnsRecordValue;
    if (selectorFromRotation) return undefined;

    try {
      const created = await runPostfixManager<{ dnsRecordValue: string }>(
        "generate_dkim",
        { domain: hostname, selector, keyLength: 2048 },
      );
      return created.dnsRecordValue;
    } catch (err) {
      // The rest of the check is still useful without it.
      this.logger?.warn(
        { err, hostname },
        "Could not create the DKIM key while checking mail authentication",
      );
      return undefined;
    }
  }

  /**
   * Idempotently provisions SPF, DKIM, DMARC, and MX records for a domain
   * (F4.5). Safe to call repeatedly — record creation is check-then-create,
   * never destructive.
   */
  async ensureEmailAuthRecords(
    userId: string,
    domainId: string,
  ): Promise<MailAuthStatusResponse> {
    await this.dnsService.initializeEmailAuthRecords(userId, domainId);
    await this.getOrGenerateDkim(userId, domainId, true);
    return this.getMailAuthStatus(userId, domainId);
  }

  /**
   * Synchronizes active domains from the database to Postfix's virtual domains
   * map, and their Mailbox rows into Dovecot's passwd-file (passdb + userdb)
   * so IMAP logins and Maildir++ quota rules stay current (F4.2).
   */
  async syncVirtualDomains(userId: string): Promise<{
    success: boolean;
    syncedCount: number;
    domains: string[];
    mailboxesSynced: number;
  }> {
    const snapshot = await synchronizeMailState(this.prisma);
    const domains = snapshot.domains.filter(
      (domain) => domain.userId === userId,
    );
    return {
      success: true,
      syncedCount: domains.length,
      domains: domains.map((domain) => domain.hostname),
      mailboxesSynced: domains.reduce(
        (count, domain) => count + domain.mailboxes.length,
        0,
      ),
    };
  }

  async syncVirtualAliases(
    userId: string,
  ): Promise<{ success: boolean; syncedCount: number }> {
    const snapshot = await synchronizeMailState(this.prisma);
    return {
      success: true,
      syncedCount: snapshot.aliases.filter((alias) => alias.userId === userId)
        .length,
    };
  }

  /**
   * Generates or retrieves 2048-bit RSA DKIM keys and formats DNS TXT record for a domain.
   * Also optionally auto-adds the TXT record to CoreDNS zone if domain exists.
   */
  async getOrGenerateDkim(
    userId: string,
    domainId: string,
    autoAddToDns: boolean = true,
  ): Promise<DkimRecordResponse> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
      include: {
        dnsRecords: true,
      },
    });

    if (!domain) {
      throw new MailError(
        "Domain not found or unauthorized",
        "DOMAIN_NOT_FOUND",
        404,
      );
    }

    const dkimRes = await runPostfixManager<
      DkimRecordResponse & { isNew: boolean }
    >("generate_dkim", {
      domain: domain.hostname,
      selector: "default",
      keyLength: 2048,
    });

    let inDns = false;
    const existingDns = domain.dnsRecords.find(
      (r) => r.type === "TXT" && r.name === "default._domainkey",
    );

    if (domain.dnsMode === "CONNECTED") {
      // The user publishes this at their registrar; report what public DNS serves.
      const required = buildRequiredMailRecords(domain.hostname, "127.0.0.1", {
        selector: dkimRes.selector,
        value: dkimRes.dnsRecordValue,
      }).filter((r) => r.purpose === "DKIM");
      inDns =
        (await lookupLiveMailRecords(domain.hostname, required)).length > 0;
    } else if (existingDns) {
      inDns = true;
    } else if (autoAddToDns) {
      // Auto-insert DKIM TXT record into Vexlyx DNS
      await this.prisma.dnsRecord.create({
        data: {
          type: "TXT",
          name: "default._domainkey",
          value: `"${dkimRes.dnsRecordValue}"`,
          ttl: 3600,
          domainId: domain.id,
        },
      });
      // Sync CoreDNS zone file so the new TXT record is actually resolvable,
      // not just persisted in Postgres (F4.5).
      await this.dnsService.syncZoneFile(domain.hostname, domain.id);
      inDns = true;
    }

    return {
      domain: dkimRes.domain,
      selector: dkimRes.selector,
      dnsRecordName: dkimRes.dnsRecordName,
      dnsRecordValue: dkimRes.dnsRecordValue,
      publicKey: dkimRes.publicKey,
      keyLength: dkimRes.keyLength ?? 2048,
      inDns,
    };
  }

  /**
   * Sends a test email via Postfix SMTP, returning the full SMTP handshake transcript.
   *
   * The helper talks to Postfix from inside the trusted Docker network, where
   * `permit_mynetworks` accepts any sender without authentication. The sender
   * must therefore be an address on a domain the caller owns, otherwise the
   * endpoint is a relay that can spoof any domain on the server.
   */
  async sendTestEmail(
    userId: string,
    input: SendTestEmailInput,
  ): Promise<TestEmailResultResponse> {
    const senderDomain = input.from.split("@").pop()!.toLowerCase();
    const ownedDomains = await this.prisma.domain.findMany({
      where: { userId },
      select: { hostname: true },
    });

    if (!senderBelongsToDomains(senderDomain, ownedDomains.map((d) => d.hostname))) {
      throw new MailError(
        `Sender ${input.from} is not on a domain you own. Use an address on one of your mail domains.`,
        "SENDER_NOT_OWNED",
        403,
      );
    }

    const host = process.env.SMTP_HOST || "127.0.0.1";
    const payload = {
      ...input,
      host,
    };

    const result = await runPostfixManager<TestEmailResultResponse>(
      "send_test_email",
      payload,
    );
    return result;
  }

  /**
   * Verifies open relay protection by simulating an unauthorized external-to-external delivery.
   */
  async testOpenRelay(): Promise<{
    safe: boolean;
    relayDenied: boolean;
    rcptResponse: string;
    transcript: string[];
  }> {
    const host = process.env.SMTP_HOST || "127.0.0.1";
    const port = Number(process.env.SMTP_PORT || 25);
    const result = await runPostfixManager<{
      safe: boolean;
      relayDenied: boolean;
      rcptResponse: string;
      transcript: string[];
    }>("test_relay", { host, port });
    return result;
  }

  /**
   * Probes the Roundcube webmail container's reachability and running state.
   */
  async getWebmailStatus(): Promise<WebmailStatusResponse> {
    const host = process.env.WEBMAIL_HOST || "127.0.0.1";
    const result = await runWebmailManager<WebmailStatusResponse>("status", {
      host,
      port: env.WEBMAIL_PORT,
      url: env.WEBMAIL_URL,
    });
    return result;
  }

  /**
   * Lists all messages currently in the Postfix mail queue (F4.8). Server-wide
   * across all tenants — gated at the route level to ADMIN only.
   */
  async listQueue(): Promise<QueueListResponse> {
    return runPostfixManager<QueueListResponse>("queue_list");
  }

  async deleteQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_delete", { queueId });
  }

  async flushQueue(queueId?: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_flush", { queueId });
  }

  async holdQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_hold", { queueId });
  }

  async releaseQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_release", { queueId });
  }

  /**
   * Tails and filters Postfix's delivery/bounce log (F4.8). Server-wide
   * across all tenants — gated at the route level to ADMIN only, so no
   * per-user domain/mailbox ownership check is applied here.
   */
  async getDeliveryLog(
    filter: DeliveryLogFilterInput,
  ): Promise<DeliveryLogResponse> {
    return runPostfixManager<DeliveryLogResponse>("delivery_log", filter);
  }

  /**
   * Rotates a domain's DKIM signing key (F4.8): generates a new selector/key,
   * switches OpenDKIM to sign with it, and keeps the previous selector's key
   * and DNS TXT record untouched (RETIRING) so in-flight mail signed with it
   * still validates until an admin confirms DNS propagation and removes it.
   */
  async rotateDkim(
    userId: string,
    domainId: string,
  ): Promise<DkimRotateResponse> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
    });
    if (!domain) {
      throw new MailError(
        "Domain not found or unauthorized",
        "DOMAIN_NOT_FOUND",
        404,
      );
    }

    let active = await this.prisma.dkimKey.findFirst({
      where: { domainId, status: "ACTIVE" },
    });

    if (!active) {
      // Backfill: a domain generated before F4.8 only has a filesystem key
      // under the "default" selector, with no DkimKey row yet.
      const existing = await runPostfixManager<{
        found: boolean;
        selector: string;
        publicKey: string;
      }>("get_dkim", { domain: domain.hostname, selector: "default" });
      if (existing.found) {
        active = await this.prisma.dkimKey.create({
          data: {
            domainId,
            userId,
            selector: existing.selector,
            status: "ACTIVE",
            publicKey: existing.publicKey,
            keyLength: 2048,
          },
        });
      }
    }

    const rotateRes = await runPostfixManager<{
      domain: string;
      newSelector: string;
      newDnsRecordName: string;
      newDnsRecordValue: string;
      newPublicKey: string;
      keyLength: number;
      oldSelector: string;
    }>("rotate_dkim", {
      domain: domain.hostname,
      oldSelector: active?.selector ?? "default",
    });

    await this.prisma.$transaction([
      this.prisma.dkimKey.updateMany({
        where: { domainId, status: "ACTIVE" },
        data: { status: "RETIRING" },
      }),
      this.prisma.dkimKey.create({
        data: {
          domainId,
          userId,
          selector: rotateRes.newSelector,
          status: "ACTIVE",
          publicKey: rotateRes.newPublicKey,
          keyLength: rotateRes.keyLength,
        },
      }),
    ]);

    // Publish the new selector's TXT record to DNS — never touches the
    // retiring selector's existing record. CONNECTED domains have no zone here:
    // the user adds the new record at their registrar (newKey.inDns stays false).
    const isManaged = domain.dnsMode === "MANAGED";
    if (isManaged) {
      await this.prisma.dnsRecord.create({
        data: {
          type: "TXT",
          name: `${rotateRes.newSelector}._domainkey`,
          value: `"${rotateRes.newDnsRecordValue}"`,
          ttl: 3600,
          domainId,
        },
      });
      await this.dnsService.syncZoneFile(domain.hostname, domain.id);
    }

    const keys = await this.prisma.dkimKey.findMany({
      where: { domainId },
      orderBy: { createdAt: "desc" },
    });

    return {
      domain: domain.hostname,
      newKey: {
        domain: domain.hostname,
        selector: rotateRes.newSelector,
        dnsRecordName: rotateRes.newDnsRecordName,
        dnsRecordValue: rotateRes.newDnsRecordValue,
        publicKey: rotateRes.newPublicKey,
        keyLength: rotateRes.keyLength,
        inDns: isManaged,
      },
      retiringKey: {
        selector: rotateRes.oldSelector,
        dnsRecordName: `${rotateRes.oldSelector}._domainkey.${domain.hostname}`,
      },
      keys: keys.map((k): DkimKey => ({
        id: k.id,
        domainId: k.domainId,
        selector: k.selector,
        status: k.status,
        publicKey: k.publicKey,
        keyLength: k.keyLength,
        createdAt: k.createdAt.toISOString(),
        retiredAt: k.retiredAt ? k.retiredAt.toISOString() : null,
      })),
    };
  }

  /**
   * Queries Roundcube's own SQLite database for each of the user's mailboxes'
   * most recent login (F4.8).
   */
  async getWebmailActivity(userId: string): Promise<WebmailActivityResponse> {
    const mailboxes = await this.prisma.mailbox.findMany({
      where: { userId },
      select: { address: true },
    });

    return runWebmailManager<WebmailActivityResponse>("recent_logins", {
      addresses: mailboxes.map((m) => m.address),
    });
  }
}
