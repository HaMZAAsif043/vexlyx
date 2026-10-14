import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";
import type {
  CreateMailboxInput,
  UpdateMailboxQuotaInput,
  MailboxListQuery,
  MailboxResponse,
} from "@vexlyx/shared";
import { runDovecotManager, MailService } from "../mail/service.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import type { AuditLogService } from "../audit-log/service.js";
import type { FastifyBaseLogger } from "fastify";

export class MailboxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "MailboxError";
  }
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

export class MailboxService {
  private readonly mailService: MailService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditLog: AuditLogService,
    logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {
    this.mailService = new MailService(prisma, logger);
  }

  /**
   * Lists mailboxes owned by the user, optionally filtered by domain, joined
   * with real Maildir disk usage from Dovecot.
   */
  async list(userId: string, query: MailboxListQuery): Promise<MailboxResponse[]> {
    const mailboxes = await this.prisma.mailbox.findMany({
      where: {
        userId,
        ...(query.domainId ? { domainId: query.domainId } : {}),
      },
      include: { domain: true, vacationResponder: true },
      orderBy: { createdAt: "desc" },
    });

    const addresses = mailboxes.map((m) => m.address);
    const usageRes = await runDovecotManager<{ usage: Record<string, number> }>(
      "get_usage",
      { addresses },
    ).catch(() => ({ usage: {} as Record<string, number> }));

    return mailboxes.map((m) => ({
      id: m.id,
      address: m.address,
      domainId: m.domainId,
      hostname: m.domain.hostname,
      quota: m.quota,
      status: m.status,
      usedBytes: usageRes.usage[m.address] ?? 0,
      createdAt: m.createdAt.toISOString(),
      vacationEnabled: m.vacationResponder?.enabled ?? false,
    }));
  }

  /**
   * Creates a mailbox under a domain owned by the user, generating a random
   * password (returned once, never persisted in plaintext) and syncing it
   * into Dovecot's passwd-file.
   */
  async create(
    userId: string,
    input: CreateMailboxInput,
  ): Promise<{ mailbox: MailboxResponse; password: string; warnings?: string[] }> {
    await assertUnderQuota(
      this.prisma,
      userId,
      "mailbox",
      (message, code, statusCode) => new MailboxError(message, code, statusCode),
    );

    const domain = await this.prisma.domain.findFirst({
      where: { id: input.domainId, userId },
    });

    if (!domain) {
      throw new MailboxError("Domain not found or unauthorized", "DOMAIN_NOT_FOUND", 404);
    }

    const address = `${input.localPart}@${domain.hostname}`.toLowerCase();

    const existing = await this.prisma.mailbox.findUnique({ where: { address } });
    if (existing) {
      throw new MailboxError("Mailbox address already exists", "MAILBOX_EXISTS", 409);
    }

    // Determined before creation: whether this will be the domain's first
    // mailbox, used to trigger F4.5 SPF/DKIM/DMARC/MX auto-configuration.
    const isFirstMailbox = (await this.prisma.mailbox.count({ where: { domainId: domain.id } })) === 0;

    const password = generatePassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const mailbox = await this.prisma.mailbox.create({
      data: {
        address,
        password: passwordHash,
        quota: input.quota,
        userId,
        domainId: domain.id,
      },
      include: { domain: true },
    });
    void notifyQuotaThreshold(this.prisma, userId, "mailbox");

    await this.auditLog.log(userId, "mailbox.created", { type: "Mailbox", id: mailbox.id }, {
      after: { address: mailbox.address },
    });

    const warnings = await this.syncMailServer(userId);

    if (isFirstMailbox) {
      // Auto-configure SPF/DKIM/DMARC/MX (F4.5). Never blocks mailbox
      // creation — mirrors DnsService.syncZoneFile's silent-catch philosophy.
      try {
        await this.mailService.ensureEmailAuthRecords(userId, domain.id);
      } catch {
        // Non-fatal: the mailbox exists regardless of DNS auto-config outcome.
        // The user can still trigger it manually via "Regenerate All".
      }
    }

    return {
      mailbox: {
        id: mailbox.id,
        address: mailbox.address,
        domainId: mailbox.domainId,
        hostname: mailbox.domain.hostname,
        quota: mailbox.quota,
        status: mailbox.status,
        usedBytes: 0,
        createdAt: mailbox.createdAt.toISOString(),
        vacationEnabled: false,
      },
      password,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // The database change is already committed when this runs. A failed
  // mail-server sync must not turn into an error response: for creation that
  // would discard the one-time password, and for every operation it would make
  // a saved change look like a failure. Report it as a warning instead.
  private async syncMailServer(userId: string): Promise<string[]> {
    try {
      await this.mailService.syncVirtualDomains(userId);
      return [];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return [
        `The change was saved, but the mail server could not be updated: ${reason} Use Mail → Sync to retry.`,
      ];
    }
  }

  /**
   * Generates and applies a new random password for an existing mailbox,
   * returned once in plaintext.
   */
  async resetPassword(
    userId: string,
    mailboxId: string,
  ): Promise<{ password: string; warnings?: string[] }> {
    const mailbox = await this.prisma.mailbox.findFirst({
      where: { id: mailboxId, userId },
    });

    if (!mailbox) {
      throw new MailboxError("Mailbox not found or unauthorized", "MAILBOX_NOT_FOUND", 404);
    }

    const password = generatePassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    await this.prisma.mailbox.update({
      where: { id: mailbox.id },
      data: { password: passwordHash },
    });

    const warnings = await this.syncMailServer(userId);

    return { password, ...(warnings.length > 0 && { warnings }) };
  }

  /**
   * Updates a mailbox's storage quota (megabytes; 0 = unlimited).
   */
  async updateQuota(
    userId: string,
    mailboxId: string,
    input: UpdateMailboxQuotaInput,
  ): Promise<{ warnings: string[] }> {
    const mailbox = await this.prisma.mailbox.findFirst({
      where: { id: mailboxId, userId },
    });

    if (!mailbox) {
      throw new MailboxError("Mailbox not found or unauthorized", "MAILBOX_NOT_FOUND", 404);
    }

    await this.prisma.mailbox.update({
      where: { id: mailbox.id },
      data: { quota: input.quota },
    });

    return { warnings: await this.syncMailServer(userId) };
  }

  /**
   * Deletes a mailbox and removes it from Dovecot's passwd-file.
   */
  async delete(userId: string, mailboxId: string): Promise<{ warnings: string[] }> {
    const mailbox = await this.prisma.mailbox.findFirst({
      where: { id: mailboxId, userId },
    });

    if (!mailbox) {
      throw new MailboxError("Mailbox not found or unauthorized", "MAILBOX_NOT_FOUND", 404);
    }

    await this.prisma.mailbox.delete({ where: { id: mailbox.id } });

    await this.auditLog.log(userId, "mailbox.deleted", { type: "Mailbox", id: mailboxId }, {
      before: { address: mailbox.address },
    });

    return { warnings: await this.syncMailServer(userId) };
  }
}
