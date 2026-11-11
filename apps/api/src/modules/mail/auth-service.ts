import type { PrismaClient } from "@prisma/client";
import type {
  DkimRecordResponse,
  MailAuthCheck,
  MailAuthStatusResponse,
  DkimKey,
  DkimRotateResponse,
  RequiredMailRecordResponse,
} from "@vexlyx/shared";

import { DnsService } from "../domains/dns-service.js";
import { getServerIp } from "../domains/resolvers.js";

import type { FastifyBaseLogger } from "fastify";

import {
  buildRequiredMailRecords,
  isRecordLive,
  lookupLiveMailRecords,
} from "./required-records.js";

import { MailError } from "./errors.js";
import { runPostfixManager } from "./manager.js";

export class MailAuthService {
  private readonly dnsService: DnsService;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {
    this.dnsService = new DnsService(prisma, logger);
  }
  /**
   * Picks the records the deliverability scorecard is computed from. MANAGED
   * domains use their own DnsRecord rows; CONNECTED domains have no zone here,
   * so their scorecard comes from live public DNS and they get the list of
   * records to publish at their registrar (F5.26).
   */
  async resolveAuthRecords(
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
   * Pure, I/O-free computation of the F4.5 internal-only deliverability
   * scorecard from an already-fetched set of DNS records. No external DNS
   * lookups or third-party API calls are made — callers pass in either
   * Vexlyx's own DnsRecord rows (MANAGED) or already-resolved live records
   * (CONNECTED, see resolveAuthRecords).
   */
  computeAuthChecks(
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
  async connectedDomainDkimValue(
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
}
