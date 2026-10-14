import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import type { PrismaClient, Domain } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  generateZoneFile,
  parseZoneFile,
} from "@vexlyx/shared";
import type {
  DnsDelegationCheckResponse,
  DnsMode,
  CreateDnsRecordInput,
  UpdateDnsRecordInput,
  DnsRecordResponse,
  DnsPropagationResponse,
  DnsResolverCheck,
  DnsRecordType,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { DomainError } from "./service.js";
import { PUBLIC_RESOLVER_IPS, getServerIp } from "./resolvers.js";
import { buildRequiredMailRecords } from "../mail/required-records.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCoreDnsZonesDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "docker/coredns/zones"),
    path.resolve(process.cwd(), "../../docker/coredns/zones"),
    path.resolve(process.cwd(), "../docker/coredns/zones"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  const fallback = path.resolve(process.cwd(), "../../docker/coredns/zones");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    // Ignore directory creation error in read-only environments
  }
  return fallback;
}

export function checkDnsZonesDirWritable():
  | { ok: true; path: string }
  | { ok: false; path: string; error: string } {
  const zonesDir = getCoreDnsZonesDir();
  try {
    if (!fs.statSync(zonesDir).isDirectory()) {
      throw new Error("not a directory");
    }
    fs.accessSync(zonesDir, fs.constants.W_OK | fs.constants.X_OK);
    return { ok: true, path: zonesDir };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, path: zonesDir, error: reason };
  }
}

export class DnsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {}

  /**
   * Helper to verify domain ownership.
   */
  private async getDomainOrThrow(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
    });

    if (!domain) {
      throw new DomainError("Domain not found or unauthorized", "DOMAIN_NOT_FOUND", 404);
    }

    return domain;
  }

  /**
   * List all DNS records for a domain.
   */
  async listRecords(userId: string, domainId: string): Promise<DnsRecordResponse[]> {
    await this.getDomainOrThrow(userId, domainId);

    const records = await this.prisma.dnsRecord.findMany({
      where: { domainId },
      orderBy: [{ type: "asc" }, { name: "asc" }, { createdAt: "asc" }],
    });

    return records.map((r) => ({
      id: r.id,
      type: r.type as DnsRecordType,
      name: r.name,
      value: r.value,
      ttl: r.ttl,
      priority: r.priority,
      weight: r.weight,
      port: r.port,
      domainId: r.domainId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Create a single DNS record with RFC conflict validation.
   */
  async createRecord(
    userId: string,
    domainId: string,
    input: CreateDnsRecordInput,
  ): Promise<DnsRecordResponse> {
    const domain = await this.getDomainOrThrow(userId, domainId);

    // RFC 1912: CNAME records cannot coexist with any other record of the same name
    if (input.type === "CNAME") {
      const existing = await this.prisma.dnsRecord.findFirst({
        where: { domainId, name: input.name },
      });
      if (existing) {
        throw new DomainError(
          `Cannot create CNAME record: other records already exist for "${input.name}"`,
          "CNAME_CONFLICT",
          400,
        );
      }
    } else {
      const existingCname = await this.prisma.dnsRecord.findFirst({
        where: { domainId, name: input.name, type: "CNAME" },
      });
      if (existingCname) {
        throw new DomainError(
          `Cannot create ${input.type} record: a CNAME record already exists for "${input.name}"`,
          "CNAME_CONFLICT",
          400,
        );
      }
    }

    const record = await this.prisma.dnsRecord.create({
      data: {
        type: input.type,
        name: input.name,
        value: input.value,
        ttl: input.ttl,
        priority: input.priority ?? null,
        weight: input.weight ?? null,
        port: input.port ?? null,
        domainId: domain.id,
      },
    });

    // Synchronize zone file for CoreDNS/BIND9
    await this.syncZoneFile(domain.hostname, domain.id);

    return {
      id: record.id,
      type: record.type as DnsRecordType,
      name: record.name,
      value: record.value,
      ttl: record.ttl,
      priority: record.priority,
      weight: record.weight,
      port: record.port,
      domainId: record.domainId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Update an existing DNS record.
   */
  async updateRecord(
    userId: string,
    domainId: string,
    recordId: string,
    input: UpdateDnsRecordInput,
  ): Promise<DnsRecordResponse> {
    const domain = await this.getDomainOrThrow(userId, domainId);

    const existing = await this.prisma.dnsRecord.findFirst({
      where: { id: recordId, domainId },
    });

    if (!existing) {
      throw new DomainError("DNS record not found", "RECORD_NOT_FOUND", 404);
    }

    const updated = await this.prisma.dnsRecord.update({
      where: { id: recordId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.value !== undefined && { value: input.value }),
        ...(input.ttl !== undefined && { ttl: input.ttl }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.port !== undefined && { port: input.port }),
      },
    });

    await this.syncZoneFile(domain.hostname, domain.id);

    return {
      id: updated.id,
      type: updated.type as DnsRecordType,
      name: updated.name,
      value: updated.value,
      ttl: updated.ttl,
      priority: updated.priority,
      weight: updated.weight,
      port: updated.port,
      domainId: updated.domainId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Delete a DNS record.
   */
  async deleteRecord(userId: string, domainId: string, recordId: string): Promise<void> {
    const domain = await this.getDomainOrThrow(userId, domainId);

    const existing = await this.prisma.dnsRecord.findFirst({
      where: { id: recordId, domainId },
    });

    if (!existing) {
      throw new DomainError("DNS record not found", "RECORD_NOT_FOUND", 404);
    }

    await this.prisma.dnsRecord.delete({
      where: { id: recordId },
    });

    await this.syncZoneFile(domain.hostname, domain.id);
  }

  /**
   * Pre-populate recommended default records (Apex A, www CNAME, ns1/ns2 NS).
   */
  async initializeDefaultRecords(userId: string, domainId: string): Promise<DnsRecordResponse[]> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    const serverIp = getServerIp();

    const defaults: Array<{
      type: DnsRecordType;
      name: string;
      value: string;
      ttl: number;
      priority?: number;
    }> = [
      { type: "A", name: "@", value: serverIp, ttl: 3600 },
      { type: "CNAME", name: "www", value: domain.hostname, ttl: 3600 },
      ...env.DNS_NAMESERVERS.map((value) => ({ type: "NS" as const, name: "@", value, ttl: 86400 })),
    ];

    for (const def of defaults) {
      const exists = await this.prisma.dnsRecord.findFirst({
        where: {
          domainId: domain.id,
          type: def.type,
          name: def.name,
        },
      });

      if (!exists) {
        await this.prisma.dnsRecord.create({
          data: {
            domainId: domain.id,
            type: def.type,
            name: def.name,
            value: def.value,
            ttl: def.ttl,
            priority: def.priority ?? null,
          },
        });
      }
    }

    await this.syncZoneFile(domain.hostname, domain.id);
    return this.listRecords(userId, domainId);
  }

  /**
   * Auto-generates SPF, DMARC, and MX (if missing) DNS records for email
   * deliverability (F4.5). DKIM is handled separately by
   * MailService.getOrGenerateDkim since it requires Python key generation.
   * Idempotent: safe to call repeatedly, never overwrites an existing
   * custom record (e.g. a pre-existing MX pointing at Google Workspace).
   */
  async initializeEmailAuthRecords(userId: string, domainId: string): Promise<DnsRecordResponse[]> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    // CONNECTED domains keep DNS at the user's registrar — mail records are shown
    // to them (see mail/required-records.ts), never written to a zone we don't serve.
    if (domain.dnsMode !== "MANAGED") return [];

    const serverIp = getServerIp();
    const required = buildRequiredMailRecords(domain.hostname, serverIp);
    const valueOf = (purpose: string) => required.find((r) => r.purpose === purpose)?.value ?? "";

    const defaults: Array<{
      type: DnsRecordType;
      name: string;
      value: string;
      ttl: number;
      priority?: number;
      /** Custom existence check — SPF must be matched by value prefix, not name alone. */
      exists: () => Promise<boolean>;
    }> = [
      {
        type: "TXT",
        name: "@",
        value: valueOf("SPF"),
        ttl: 3600,
        // Other unrelated TXT records may already exist at "@", so SPF is
        // identified by its "v=spf1" prefix rather than name alone.
        exists: async () =>
          !!(await this.prisma.dnsRecord.findFirst({
            where: { domainId: domain.id, type: "TXT", name: "@", value: { startsWith: "v=spf1" } },
          })),
      },
      {
        type: "TXT",
        name: "_dmarc",
        value: valueOf("DMARC"),
        ttl: 3600,
        exists: async () =>
          !!(await this.prisma.dnsRecord.findFirst({
            where: { domainId: domain.id, type: "TXT", name: "_dmarc" },
          })),
      },
      {
        type: "A",
        name: "mail",
        value: valueOf("HOST"),
        ttl: 3600,
        exists: async () =>
          !!(await this.prisma.dnsRecord.findFirst({
            where: { domainId: domain.id, type: { in: ["A", "CNAME"] }, name: "mail" },
          })),
      },
      {
        type: "MX",
        name: "@",
        value: valueOf("MX"),
        ttl: 3600,
        priority: 10,
        exists: async () =>
          !!(await this.prisma.dnsRecord.findFirst({
            where: { domainId: domain.id, type: "MX", name: "@" },
          })),
      },
    ];

    let created = false;
    for (const def of defaults) {
      if (await def.exists()) continue;

      await this.prisma.dnsRecord.create({
        data: {
          domainId: domain.id,
          type: def.type,
          name: def.name,
          value: def.value,
          ttl: def.ttl,
          priority: def.priority ?? null,
        },
      });
      created = true;
    }

    if (created) {
      await this.syncZoneFile(domain.hostname, domain.id);
    }

    return this.listRecords(userId, domainId);
  }

  /**
   * Export an RFC 1035 zone file.
   */
  async exportZoneFile(
    userId: string,
    domainId: string,
  ): Promise<{ filename: string; content: string }> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    const records = await this.prisma.dnsRecord.findMany({
      where: { domainId },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });

    const content = generateZoneFile(domain.hostname, records);
    return {
      filename: `${domain.hostname}.zone`,
      content,
    };
  }

  /**
   * Import records from an RFC 1035 zone file.
   */
  async importZoneFile(
    userId: string,
    domainId: string,
    zoneContent: string,
    strategy: "skip" | "replace" = "skip",
  ): Promise<{ importedCount: number; records: DnsRecordResponse[]; errors: string[] }> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    const { records: parsedRecords, errors } = parseZoneFile(zoneContent, domain.hostname);

    if (parsedRecords.length === 0 && errors.length > 0) {
      throw new DomainError(
        `Failed to parse zone file: ${errors.join("; ")}`,
        "ZONE_PARSE_ERROR",
        400,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (strategy === "replace") {
        await tx.dnsRecord.deleteMany({
          where: { domainId },
        });
      }

      for (const rec of parsedRecords) {
        if (strategy === "skip") {
          const exists = await tx.dnsRecord.findFirst({
            where: {
              domainId,
              type: rec.type,
              name: rec.name,
              value: rec.value,
            },
          });
          if (exists) continue;
        }

        await tx.dnsRecord.create({
          data: {
            domainId,
            type: rec.type,
            name: rec.name,
            value: rec.value,
            ttl: rec.ttl,
            priority: rec.priority ?? null,
            weight: rec.weight ?? null,
            port: rec.port ?? null,
          },
        });
      }
    });

    await this.syncZoneFile(domain.hostname, domain.id);
    const allRecords = await this.listRecords(userId, domainId);

    return {
      importedCount: parsedRecords.length,
      records: allRecords,
      errors,
    };
  }

  /**
   * Check DNS propagation status against major public resolvers.
   */
  async checkPropagation(
    userId: string,
    domainId: string,
    recordId: string,
  ): Promise<DnsPropagationResponse> {
    const domain = await this.getDomainOrThrow(userId, domainId);

    const record = await this.prisma.dnsRecord.findFirst({
      where: { id: recordId, domainId },
    });

    if (!record) {
      throw new DomainError("DNS record not found", "RECORD_NOT_FOUND", 404);
    }

    // Determine query target FQDN
    const cleanHost = domain.hostname.startsWith("*.") ? domain.hostname.slice(2) : domain.hostname;
    let queryTarget: string;
    if (record.name === "@") {
      queryTarget = cleanHost;
    } else if (record.name.endsWith(cleanHost)) {
      queryTarget = record.name;
    } else {
      queryTarget = `${record.name}.${cleanHost}`;
    }

    const resolversToQuery = [
      { name: "Cloudflare (1.1.1.1)", ip: "1.1.1.1" },
      { name: "Google (8.8.8.8)", ip: "8.8.8.8" },
      { name: "Quad9 (9.9.9.9)", ip: "9.9.9.9" },
    ];

    const results: DnsResolverCheck[] = [];

    for (const r of resolversToQuery) {
      const startTime = Date.now();
      try {
        const resolver = new dns.Resolver();
        resolver.setServers([r.ip]);

        let detectedValues: string[] = [];
        const type = record.type.toUpperCase();

        if (type === "A") {
          const res = await resolver.resolve4(queryTarget);
          detectedValues = res;
        } else if (type === "AAAA") {
          const res = await resolver.resolve6(queryTarget);
          detectedValues = res;
        } else if (type === "CNAME") {
          const res = await resolver.resolveCname(queryTarget);
          detectedValues = res;
        } else if (type === "MX") {
          const res = await resolver.resolveMx(queryTarget);
          detectedValues = res.map((m) => `${m.priority} ${m.exchange}`);
        } else if (type === "TXT") {
          const res = await resolver.resolveTxt(queryTarget);
          detectedValues = res.map((chunks) => chunks.join(""));
        } else if (type === "NS") {
          const res = await resolver.resolveNs(queryTarget);
          detectedValues = res;
        } else if (type === "SRV") {
          const res = await resolver.resolveSrv(queryTarget);
          detectedValues = res.map((s) => `${s.priority} ${s.weight} ${s.port} ${s.name}`);
        }

        const latencyMs = Date.now() - startTime;
        const normalizedExpected = record.value.trim().toLowerCase().replace(/\.$/, "");
        const isMatch = detectedValues.some(
          (v) => v.trim().toLowerCase().replace(/\.$/, "") === normalizedExpected,
        );

        results.push({
          resolver: r.name,
          ip: r.ip,
          status: isMatch ? "MATCH" : detectedValues.length > 0 ? "MISMATCH" : "NOT_FOUND",
          detectedValues,
          latencyMs,
        });
      } catch (err: unknown) {
        const latencyMs = Date.now() - startTime;
        const errCode = (err as { code?: string })?.code;
        results.push({
          resolver: r.name,
          ip: r.ip,
          status: errCode === "ENOTFOUND" || errCode === "ENODATA" ? "NOT_FOUND" : "ERROR",
          detectedValues: [],
          latencyMs,
          error: (err as Error)?.message || "Query timeout",
        });
      }
    }

    const isFullyPropagated =
      results.length > 0 && results.every((r) => r.status === "MATCH");

    return {
      recordId: record.id,
      recordType: record.type as DnsRecordType,
      recordName: record.name,
      expectedValue: record.value,
      isFullyPropagated,
      resolvers: results,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Checks whether the domain's public NS records point at Vexlyx's nameservers.
   * Any one public resolver seeing every expected nameserver counts as delegated,
   * matching the verification approach in DomainService.verify.
   */
  async checkDelegation(userId: string, domainId: string): Promise<DnsDelegationCheckResponse> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    const expected = env.DNS_NAMESERVERS;

    if (process.env.NODE_ENV === "test" || process.env.VEXLYX_MOCK_DNS === "true") {
      return { delegated: true, found: expected, expected };
    }

    const baseTarget = domain.hostname.startsWith("*.") ? domain.hostname.slice(2) : domain.hostname;
    const found = new Set<string>();
    let delegated = false;

    for (const resolverIp of PUBLIC_RESOLVER_IPS) {
      try {
        const resolver = new dns.Resolver();
        resolver.setServers([resolverIp]);
        const names = (await resolver.resolveNs(baseTarget)).map((n) => n.toLowerCase().replace(/\.$/, ""));
        names.forEach((n) => found.add(n));
        if (expected.every((ns) => names.includes(ns))) delegated = true;
      } catch {
        // No NS answer from this resolver — treated as not delegated
      }
    }

    return { delegated, found: [...found], expected };
  }

  /**
   * Switches a domain between CONNECTED (DNS stays with the user's provider) and
   * MANAGED (Vexlyx CoreDNS is authoritative). Enabling requires a verified domain
   * whose nameservers are already delegated to us; disabling is blocked while the
   * domain has mailboxes, since their MX/DKIM/SPF records live in the zone.
   */
  async setDnsMode(
    userId: string,
    domainId: string,
    mode: DnsMode,
    skipDelegationCheck = false,
  ): Promise<Domain> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    if (domain.dnsMode === mode) return domain;

    if (mode === "MANAGED") {
      if (domain.status !== "ACTIVE") {
        throw new DomainError(
          "Verify domain ownership before hosting its DNS on Vexlyx",
          "DOMAIN_NOT_VERIFIED",
          409,
        );
      }
      const delegation = skipDelegationCheck
        ? { delegated: true, found: [], expected: env.DNS_NAMESERVERS }
        : await this.checkDelegation(userId, domainId);
      if (!delegation.delegated) {
        throw new DomainError(
          `Nameservers are not pointed at ${delegation.expected.join(", ")} yet`,
          "NS_NOT_DELEGATED",
          409,
        );
      }
    } else {
      const mailboxCount = await this.prisma.mailbox.count({ where: { domainId } });
      if (mailboxCount > 0) {
        throw new DomainError(
          "Remove this domain's mailboxes before switching DNS back to your own provider",
          "DNS_MODE_MAIL_ACTIVE",
          409,
        );
      }
    }

    const updated = await this.prisma.domain.update({
      where: { id: domain.id },
      data: { dnsMode: mode },
    });

    if (mode === "MANAGED") {
      await this.initializeDefaultRecords(userId, domainId);
    } else {
      this.removeZoneFile(domain.hostname);
    }

    return updated;
  }

  /**
   * Throws 409 DNS_NOT_MANAGED unless Vexlyx is authoritative for this domain.
   */
  async assertManaged(userId: string, domainId: string): Promise<void> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    if (domain.dnsMode !== "MANAGED") {
      throw new DomainError(
        "DNS for this domain is not hosted on Vexlyx",
        "DNS_NOT_MANAGED",
        409,
      );
    }
  }

  private removeZoneFile(hostname: string): void {
    const cleanHost = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
    try {
      fs.rmSync(path.join(getCoreDnsZonesDir(), `${cleanHost}.db`), { force: true });
    } catch (err) {
      this.logger?.warn({ err, hostname: cleanHost }, "Failed to remove DNS zone file");
    }
  }

  async resyncZone(userId: string, domainId: string): Promise<{ synced: true }> {
    const domain = await this.getDomainOrThrow(userId, domainId);
    await this.syncZoneFile(domain.hostname, domain.id);
    return { synced: true };
  }

  async syncAllManagedZones(): Promise<number> {
    const domains = await this.prisma.domain.findMany({
      where: { dnsMode: "MANAGED" },
      select: { id: true, hostname: true },
    });

    const failed: string[] = [];
    for (const domain of domains) {
      try {
        await this.syncZoneFile(domain.hostname, domain.id);
      } catch (err) {
        failed.push(domain.hostname);
        this.logger?.error({ err, hostname: domain.hostname }, "Failed to sync hosted DNS zone");
      }
    }

    if (failed.length > 0) {
      throw new DomainError(
        `${failed.length} of ${domains.length} hosted DNS zone(s) could not be written: ${failed.join(", ")}`,
        "DNS_ZONE_WRITE_FAILED",
        500,
      );
    }
    return domains.length;
  }

  async syncZoneFile(hostname: string, domainId: string): Promise<void> {
    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      select: { dnsMode: true },
    });
    if (domain?.dnsMode !== "MANAGED") return;

    const records = await this.prisma.dnsRecord.findMany({
      where: { domainId },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });

    const cleanHost = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
    const zoneContent = generateZoneFile(cleanHost, records);
    const zonesDir = getCoreDnsZonesDir();
    const zoneFilePath = path.join(zonesDir, `${cleanHost}.db`);

    try {
      fs.writeFileSync(zoneFilePath, zoneContent, "utf-8");
    } catch (err) {
      // The write is what CoreDNS serves: a failure must not look like success.
      this.logger?.error(
        { err, hostname: cleanHost, zoneFilePath },
        "Failed to write DNS zone file",
      );
      const reason = (err as NodeJS.ErrnoException).code ?? "unknown filesystem error";
      throw new DomainError(
        `The change was saved, but the DNS zone file for ${cleanHost} could not be written (${reason}), so it is not being served yet. Fix the DNS zones directory (permissions, free disk space) and re-sync the zone to retry.`,
        "DNS_ZONE_WRITE_FAILED",
        500,
      );
    }
  }
}
