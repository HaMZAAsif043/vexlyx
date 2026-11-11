import { MailAuthService } from "./auth-service.js";

import type { PrismaClient } from "@prisma/client";
import type { VirtualDomain } from "@vexlyx/shared";

import { runPostfixManager } from "./manager.js";
import { synchronizeMailState } from "./synchronize.js";

export class MailDomainService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auth: MailAuthService,
  ) {}
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

      const { records, requiredRecords } = await this.auth.resolveAuthRecords(
        d,
        activeSelector,
        dkim.found ? dkim.dnsRecordValue : undefined,
      );
      const hasDnsTxt = records.some(
        (r) => r.type === "TXT" && r.name === `${activeSelector}._domainkey`,
      );

      const { checks, score, grade } = this.auth.computeAuthChecks(
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
}
