import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, Domain, Project, Certificate } from "@prisma/client";
import {
  isWildcardHostname,
  getParentDomain,
} from "@vexlyx/shared";

import type {
  CreateDomainInput,
  UpdateDomainInput,
  DomainListQuery,
  DomainResponse,
  DomainVerificationInstructions,
  DomainVerificationResult,
  CertificateResponse,
  CertStatus,
  CertType,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import type { AuditLogService } from "../audit-log/service.js";
import { PUBLIC_RESOLVER_IPS } from "./resolvers.js";
import { resolveHttpUpstream } from "./upstream.js";

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "app";
}

function getTraefikDynamicDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "docker/traefik/dynamic"),
    path.resolve(process.cwd(), "../../docker/traefik/dynamic"),
    path.resolve(process.cwd(), "../docker/traefik/dynamic"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  const fallback = path.resolve(process.cwd(), "../../docker/traefik/dynamic");
  if (!fs.existsSync(fallback)) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      // Ignore directory creation error in read-only setups
    }
  }
  return fallback;
}

function getTraefikConfigFile(domainId: string): string {
  return path.join(getTraefikDynamicDir(), `domain-${domainId}.yml`);
}

/**
 * Removes a domain's Traefik dynamic router file. Shared by DomainService and
 * ProjectService so a deleted project cannot leave a router pointing at a
 * container that no longer exists (a permanent 502 for the domain).
 */
export function removeTraefikRouteFile(
  domainId: string,
  logger?: Pick<FastifyBaseLogger, "error">,
): void {
  const configPath = getTraefikConfigFile(domainId);
  if (!fs.existsSync(configPath)) return;

  try {
    fs.unlinkSync(configPath);
  } catch (err) {
    logger?.error({ err, domainId }, "Failed to remove Traefik config for domain");
  }
}

function generateVerificationToken(): string {
  return `vexlyx-verify-${crypto.randomBytes(16).toString("hex")}`;
}

function buildVerificationInstructions(
  hostname: string,
  token: string | null,
): DomainVerificationInstructions {
  const baseTarget = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
  return {
    recordType: "TXT",
    recordName: `_vexlyx-challenge.${baseTarget}`,
    recordValue: `vexlyx-verification=${token ?? ""}`,
    // TXT verification only proves ownership — found live that a "verified"
    // domain with no A record just shows nothing, with no indication why.
    routingRecord: {
      recordType: "A",
      recordName: baseTarget,
      publicIp: env.PUBLIC_IP ?? null,
    },
  };
}

// Fields the route generator needs from a domain's project. Every query whose
// result is handed to syncTraefikRouter selects exactly this.
const ROUTE_PROJECT_SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  port: true,
  internalPort: true,
  buildCmd: true,
} as const;

// Traefik's file provider runs with `watch: true`, so a route only has to
// appear on disk. The write is a rename so the watcher never parses a
// half-written file; the temp name ends in .tmp, which the provider ignores.
// Returns false, touching nothing, when the file already has this content.
function writeRouteFileAtomically(configPath: string, content: string): boolean {
  try {
    if (fs.readFileSync(configPath, "utf-8") === content) return false;
  } catch {
    // Missing or unreadable: write it.
  }

  const tempPath = `${configPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, "utf-8");
    fs.renameSync(tempPath, configPath);
    return true;
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}

export function mapCertificateToResponse(
  cert: Certificate | null | undefined,
): CertificateResponse | null {
  if (!cert) return null;
  const diffMs = cert.validTo ? cert.validTo.getTime() - Date.now() : null;
  const daysRemaining = diffMs !== null ? Math.floor(diffMs / (1000 * 60 * 60 * 24)) : null;
  const isExpired = diffMs !== null ? diffMs <= 0 : false;
  const isExpiringSoon = diffMs !== null ? !isExpired && daysRemaining! <= 7 : false;

  return {
    id: cert.id,
    domainId: cert.domainId,
    type: cert.type as CertType,
    status: cert.status as CertStatus,
    issuer: cert.issuer,
    commonName: cert.commonName,
    sans: cert.sans,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysRemaining,
    autoRenew: cert.autoRenew,
    forceHttps: cert.forceHttps,
    serialNumber: cert.serialNumber,
    errorMessage: cert.errorMessage,
    lastCheckedAt: cert.lastCheckedAt,
    lastRenewedAt: cert.lastRenewedAt,
    isExpiringSoon,
    isExpired,
  };
}

// ---------------------------------------------------------------------------
// Service Layer
// ---------------------------------------------------------------------------

/** A domain with what the route generator needs from it and its project. */
type RouteDomain = Domain & {
  pathPrefix?: string | null;
  certificate?: {
    type: string;
    forceHttps?: boolean;
    certPath?: string | null;
    keyPath?: string | null;
  } | null;
  project:
    | (Pick<Project, "id" | "name" | "status"> & {
        type?: string;
        buildCmd?: string | null;
        port?: number | null;
        internalPort?: number | null;
      })
    | null;
};

export class DomainService {
  // Optional: SslService constructs a DomainService of its own purely to
  // reuse its Traefik-sync helpers, with no audit-relevant calls — so this
  // is only required on the instance routes.ts hands to create()/delete().
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditLog?: AuditLogService,
    private readonly logger?: Pick<FastifyBaseLogger, "error" | "warn" | "info">,
  ) {}

  /**
   * Syncs Traefik dynamic router configuration file for an ACTIVE domain.
   * If domain is not ACTIVE or has no project, removes configuration.
   * Specific subdomains get priority: 100, while wildcards get priority: 10.
   */
  public syncTraefikRouter(domain: RouteDomain): void {
    if (domain.status !== "ACTIVE" || !domain.project) {
      this.removeTraefikRouter(domain.id, false);
      return;
    }

    try {
      this.writeRouteFile(domain, domain.project);
    } catch (err) {
      this.logger?.error(
        { err, domainId: domain.id },
        "Failed to write Traefik config for domain",
      );
    }
  }

  /**
   * Rewrites the route file of every active, attached domain from current
   * data. Repairs routes generated by older versions (before #150 they
   * pointed WordPress and no-build PHP at the PHP-FPM container, a 502) in
   * one pass at start-up. Idempotent: a file that is already correct is left
   * alone, and Traefik's file watcher picks up the rest with no restart.
   */
  public async syncAllRoutes(): Promise<{
    written: number;
    unchanged: number;
    failed: number;
  }> {
    const domains = await this.prisma.domain.findMany({
      where: {
        status: "ACTIVE",
        projectId: { not: null },
        project: { deletedAt: null },
      },
      include: {
        certificate: true,
        project: { select: ROUTE_PROJECT_SELECT },
      },
    });

    const result = { written: 0, unchanged: 0, failed: 0 };
    for (const domain of domains) {
      if (!domain.project) continue;
      try {
        if (this.writeRouteFile(domain, domain.project)) {
          result.written++;
          this.logger?.info(
            { domainId: domain.id, hostname: domain.hostname },
            "Regenerated Traefik route",
          );
        } else {
          result.unchanged++;
        }
      } catch (err) {
        result.failed++;
        this.logger?.error(
          { err, domainId: domain.id },
          "Failed to regenerate Traefik route for domain",
        );
      }
    }
    return result;
  }

  /** Renders and writes one domain's route file; true if the file changed. */
  private writeRouteFile(
    domain: RouteDomain,
    project: NonNullable<RouteDomain["project"]>,
  ): boolean {
    const configPath = getTraefikConfigFile(domain.id);

    const serviceName = slugify(project.id.slice(0, 12));
    const upstream = resolveHttpUpstream(project);
    const upstreamUrl = `http://vexlyx-${serviceName}-${upstream.service}-1:${upstream.port}`;

    const isWildcard = isWildcardHostname(domain.hostname);
    // Explicit Traefik priority: specific subdomains take precedence over wildcards
    const priority = isWildcard ? 10 : 100;

    let rule = `Host(\`${domain.hostname}\`)`;
    if (domain.pathPrefix && domain.pathPrefix.trim().length > 0) {
      const cleanPrefix = domain.pathPrefix.trim();
      rule = `Host(\`${domain.hostname}\`) && PathPrefix(\`${cleanPrefix}\`)`;
    }

    let ymlContent = "";

    if (domain.sslEnabled) {
      const cert = domain.certificate;
      const forceHttps = cert?.forceHttps !== false;
      const isCustomOrSelfSigned =
        cert?.type === "CUSTOM" || cert?.type === "SELF_SIGNED";

      let tlsConfig = "";
      if (isCustomOrSelfSigned) {
        tlsConfig = `      tls: {}\n`;
      } else {
        tlsConfig = `      tls:\n        certResolver: letsencrypt\n`;
      }

      let middlewaresBlock = "";
      let httpRouterMiddlewares = "";
      if (forceHttps) {
        middlewaresBlock = `  middlewares:\n    redirect-to-https-${domain.id}:\n      redirectScheme:\n        scheme: https\n        permanent: true\n`;
        httpRouterMiddlewares = `      middlewares:\n        - redirect-to-https-${domain.id}\n`;
      }

      let tlsBlock = "";
      if (isCustomOrSelfSigned) {
        tlsBlock = `tls:\n  certificates:\n    - certFile: /etc/traefik/certs/domain-${domain.id}.crt\n      keyFile: /etc/traefik/certs/domain-${domain.id}.key\n`;
      }

      ymlContent = `# Auto-generated by Vexlyx with SSL for domain: ${domain.hostname}
# Project: ${project.name} (${project.id})
http:
  routers:
    domain-${domain.id}-http:
      rule: ${rule}
      priority: ${priority}
      entryPoints:
        - web
${httpRouterMiddlewares}      service: service-${domain.id}
    domain-${domain.id}-https:
      rule: ${rule}
      priority: ${priority}
      entryPoints:
        - websecure
${tlsConfig}      service: service-${domain.id}
${middlewaresBlock}  services:
    service-${domain.id}:
      loadBalancer:
        servers:
          - url: "${upstreamUrl}"
${tlsBlock}`;
    } else {
      ymlContent = `# Auto-generated by Vexlyx for domain: ${domain.hostname}
# Project: ${project.name} (${project.id})
http:
  routers:
    domain-${domain.id}:
      rule: ${rule}
      priority: ${priority}
      entryPoints:
        - web
      service: service-${domain.id}
  services:
    service-${domain.id}:
      loadBalancer:
        servers:
          - url: "${upstreamUrl}"
`;
    }

    return writeRouteFileAtomically(configPath, ymlContent);
  }

  /**
   * Removes Traefik dynamic router configuration file for a domain.
   */
  public removeTraefikRouter(domainId: string, removeCertificates = true): void {
    removeTraefikRouteFile(domainId, this.logger);

    if (!removeCertificates) return;

    // Clean up any custom certificate files
    try {
      const candidates = [
        path.resolve(process.cwd(), "docker/traefik/certs"),
        path.resolve(process.cwd(), "../../docker/traefik/certs"),
      ];
      for (const dir of candidates) {
        const certFile = path.join(dir, `domain-${domainId}.crt`);
        const keyFile = path.join(dir, `domain-${domainId}.key`);
        if (fs.existsSync(certFile)) fs.unlinkSync(certFile);
        if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Registers a new custom domain or subdomain.
   * If the domain is a subdomain of an already ACTIVE parent domain owned by this user,
   * verification is automatically inherited and status is set directly to ACTIVE.
   */
  public async create(userId: string, input: CreateDomainInput): Promise<DomainResponse> {
    const existing = await this.prisma.domain.findUnique({
      where: { hostname: input.hostname },
    });

    if (existing) {
      throw new DomainError(
        `Domain "${input.hostname}" is already registered on this panel`,
        "DOMAIN_ALREADY_EXISTS",
        409,
      );
    }

    await assertUnderQuota(
      this.prisma,
      userId,
      "domain",
      (message, code, statusCode) => new DomainError(message, code, statusCode),
    );

    let project: Project | null = null;
    if (input.projectId) {
      project = await this.prisma.project.findFirst({
        where: { id: input.projectId, userId, deletedAt: null },
      });

      if (!project) {
        throw new DomainError("Associated project not found", "PROJECT_NOT_FOUND", 404);
      }
    }

    // Detect parent domain relation for inheritance
    const parentCandidate = getParentDomain(input.hostname);
    let parentDomain = null;
    if (input.parentId) {
      parentDomain = await this.prisma.domain.findFirst({
        where: { id: input.parentId, userId },
      });
    } else if (parentCandidate) {
      parentDomain = await this.prisma.domain.findFirst({
        where: { hostname: parentCandidate, userId },
      });
    }

    // Account-Level Verification Inheritance:
    // If user owns and has verified the parent domain, automatically inherit verification!
    const isInheritedActive = parentDomain !== null && parentDomain.status === "ACTIVE";
    const status = isInheritedActive ? "ACTIVE" : "PENDING";
    const verificationToken = parentDomain?.verificationToken ?? generateVerificationToken();
    const parentId = parentDomain?.id ?? null;
    const pathPrefix = input.pathPrefix?.trim() || null;

    const domain = await this.prisma.domain.create({
      data: {
        hostname: input.hostname,
        status,
        verificationToken,
        parentId,
        pathPrefix,
        userId,
        projectId: input.projectId ?? null,
        // Connect-only by default: no DnsRecord rows are created (the verification
        // TXT is checked against the token, not a stored record). A subdomain of a
        // parent Vexlyx already hosts DNS for stays in that zone.
        dnsMode: parentDomain?.dnsMode ?? "CONNECTED",
      },
      include: {
        project: { select: ROUTE_PROJECT_SELECT },
        parent: {
          select: { id: true, hostname: true, status: true },
        },
        certificate: true,
      },
    });
    void notifyQuotaThreshold(this.prisma, userId, "domain");

    // If automatically active (inherited), sync Traefik dynamic router immediately
    if (domain.status === "ACTIVE" && domain.project) {
      this.syncTraefikRouter(domain);
    }

    await this.auditLog?.log(userId, "domain.created", { type: "Domain", id: domain.id }, {
      after: { hostname: domain.hostname },
    });

    return {
      ...domain,
      isWildcard: isWildcardHostname(domain.hostname),
      certificate: mapCertificateToResponse(domain.certificate),
      sslStatus: (domain.certificate?.status as CertStatus) ?? (domain.sslEnabled ? "ACTIVE" : undefined),
      verificationInstructions: buildVerificationInstructions(
        domain.hostname,
        domain.verificationToken,
      ),
    };
  }

  /**
   * Changes only the project assignment while preserving domain resources.
   */
  public async update(userId: string, domainId: string, input: UpdateDomainInput): Promise<DomainResponse> {
    const domain = await this.prisma.domain.findFirst({ where: { id: domainId, userId } });
    if (!domain) throw new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404);

    if (input.projectId !== null) {
      const project = await this.prisma.project.findFirst({
        where: { id: input.projectId, userId, deletedAt: null },
      });
      if (!project) throw new DomainError("Associated project not found", "PROJECT_NOT_FOUND", 404);
    }

    const updated = await this.prisma.domain.update({
      where: { id: domain.id, userId },
      data: { projectId: input.projectId },
      include: {
        project: { select: ROUTE_PROJECT_SELECT },
        certificate: true,
      },
    });
    this.syncTraefikRouter(updated);
    await this.auditLog?.log(userId, "domain.updated", { type: "Domain", id: domain.id }, {
      before: { projectId: domain.projectId },
      after: { projectId: updated.projectId },
    });
    return this.getById(userId, domainId);
  }

  /** Lists owned domains with optional project, parent, and search filters. */
  public async list(userId: string, query: DomainListQuery): Promise<DomainResponse[]> {
    const where: {
      userId: string;
      projectId?: string;
      status?: "PENDING" | "ACTIVE" | "ERROR";
      hostname?: { contains: string; mode: "insensitive" };
      parentId?: string | null;
    } = { userId };

    if (query.projectId) {
      where.projectId = query.projectId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.search) {
      where.hostname = { contains: query.search.toLowerCase(), mode: "insensitive" };
    }
    if (query.parentId !== undefined) {
      where.parentId = query.parentId;
    } else if (query.rootOnly === true) {
      where.parentId = null;
    }

    const domains = await this.prisma.domain.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: (query.page - 1) * query.limit,
      include: {
        project: {
          select: { id: true, name: true, type: true, status: true },
        },
        parent: {
          select: { id: true, hostname: true, status: true },
        },
        certificate: true,
        subdomains: {
          include: {
            project: {
              select: { id: true, name: true, type: true, status: true },
            },
            certificate: true,
          },
          orderBy: { hostname: "asc" },
        },
      },
    });

    return domains.map((domain) => ({
      ...domain,
      isWildcard: isWildcardHostname(domain.hostname),
      subdomainCount: domain.subdomains?.length ?? 0,
      certificate: mapCertificateToResponse(domain.certificate),
      sslStatus: (domain.certificate?.status as CertStatus) ?? (domain.sslEnabled ? "ACTIVE" : undefined),
      subdomains: domain.subdomains?.map((sub) => ({
        ...sub,
        isWildcard: isWildcardHostname(sub.hostname),
        certificate: mapCertificateToResponse(sub.certificate),
        sslStatus: (sub.certificate?.status as CertStatus) ?? (sub.sslEnabled ? "ACTIVE" : undefined),
      })),
      verificationInstructions: buildVerificationInstructions(
        domain.hostname,
        domain.verificationToken,
      ),
    }));
  }

  /**
   * Retrieves all subdomains for a specific parent domain.
   */
  public async listSubdomains(userId: string, parentId: string): Promise<DomainResponse[]> {
    const parent = await this.prisma.domain.findFirst({
      where: { id: parentId, userId },
    });
    if (!parent) {
      throw new DomainError("Parent domain not found", "DOMAIN_NOT_FOUND", 404);
    }

    const subdomains = await this.prisma.domain.findMany({
      where: { parentId, userId },
      orderBy: { hostname: "asc" },
      include: {
        project: {
          select: { id: true, name: true, type: true, status: true },
        },
      },
    });

    return subdomains.map((sub) => ({
      ...sub,
      isWildcard: isWildcardHostname(sub.hostname),
      verificationInstructions: buildVerificationInstructions(
        sub.hostname,
        sub.verificationToken,
      ),
    }));
  }

  /**
   * Retrieves domain details by ID.
   */
  public async getById(userId: string, domainId: string): Promise<DomainResponse> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
      include: {
        project: {
          select: { id: true, name: true, type: true, status: true },
        },
        parent: {
          select: { id: true, hostname: true, status: true },
        },
        certificate: true,
        subdomains: {
          include: {
            project: {
              select: { id: true, name: true, type: true, status: true },
            },
            certificate: true,
          },
        },
      },
    });

    if (!domain) {
      throw new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404);
    }

    return {
      ...domain,
      isWildcard: isWildcardHostname(domain.hostname),
      subdomainCount: domain.subdomains?.length ?? 0,
      certificate: mapCertificateToResponse(domain.certificate),
      sslStatus: (domain.certificate?.status as CertStatus) ?? (domain.sslEnabled ? "ACTIVE" : undefined),
      subdomains: domain.subdomains?.map((sub) => ({
        ...sub,
        isWildcard: isWildcardHostname(sub.hostname),
        certificate: mapCertificateToResponse(sub.certificate),
        sslStatus: (sub.certificate?.status as CertStatus) ?? (sub.sslEnabled ? "ACTIVE" : undefined),
      })),
      verificationInstructions: buildVerificationInstructions(
        domain.hostname,
        domain.verificationToken,
      ),
    };
  }

  /**
   * Validates domain ownership via DNS TXT record lookup.
   * If verified, marks status = ACTIVE and writes Traefik dynamic router config.
   * Also automatically activates any child subdomains linked to this parent domain.
   */
  public async verify(
    userId: string,
    domainId: string,
    mockTxt?: string,
    mockBypass?: boolean,
  ): Promise<DomainVerificationResult> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
      include: {
        project: { select: ROUTE_PROJECT_SELECT },
      },
    });

    if (!domain) {
      throw new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404);
    }

    const expectedInstructions = buildVerificationInstructions(
      domain.hostname,
      domain.verificationToken,
    );
    const expectedValue = expectedInstructions.recordValue;

    let detectedRecords: string[] = [];
    let isMatched = false;

    // Check mock test flag or query
    const isMockTest =
      mockBypass === true ||
      mockTxt !== undefined ||
      env.VEXLYX_MOCK_DNS === "true" ||
      process.env.VEXLYX_MOCK_DNS === "true" ||
      process.env.NODE_ENV === "test";

    if (isMockTest) {
      if (mockTxt !== undefined) {
        detectedRecords = [mockTxt];
      } else {
        detectedRecords = [expectedValue];
      }
      isMatched = detectedRecords.some((val) => val === expectedValue);
    } else {
      const baseTarget = domain.hostname.startsWith("*.")
        ? domain.hostname.slice(2)
        : domain.hostname;

      // Query DNS TXT records for _vexlyx-challenge.<baseTarget> and <baseTarget>
      const targets = [
        `_vexlyx-challenge.${baseTarget}`,
        baseTarget,
      ];

      // Query a few public resolvers directly rather than trusting whatever
      // resolver this server happens to have configured. Observed live: a
      // premature "Verify" click (before DNS had propagated) got this
      // server's cloud-provider VPC resolver to negative-cache the lookup —
      // the record was genuinely published minutes later, confirmed against
      // Cloudflare/Google/the zone's own nameserver, but the server's local
      // resolver kept reporting NXDOMAIN for the zone's full negative-cache
      // TTL (up to an hour, per its SOA). Any one public resolver actually
      // seeing the record is solid evidence it's live — no need for all of
      // them to agree before activating the domain.
      for (const target of targets) {
        for (const resolverIp of PUBLIC_RESOLVER_IPS) {
          try {
            const resolver = new dns.Resolver();
            resolver.setServers([resolverIp]);
            const rawEntries = await resolver.resolveTxt(target);
            const flattened = rawEntries.map((chunks) => chunks.join(""));
            detectedRecords.push(...flattened);
          } catch {
            // Domain / TXT record not found or DNS lookup error on this resolver
          }
        }
      }
      detectedRecords = [...new Set(detectedRecords)];

      isMatched = detectedRecords.some(
        (val) => val === expectedValue || val.includes(expectedValue),
      );
    }

    if (isMatched) {
      const updatedDomain = await this.prisma.domain.update({
        where: { id: domain.id },
        data: { status: "ACTIVE" },
        include: {
          project: { select: ROUTE_PROJECT_SELECT },
        },
      });

      // Auto-configure Traefik dynamic router file
      this.syncTraefikRouter(updatedDomain);

      // Auto-activate all pending subdomains under this domain
      const pendingSubdomains = await this.prisma.domain.findMany({
        where: { parentId: domain.id, status: "PENDING" },
        include: {
          project: { select: ROUTE_PROJECT_SELECT },
        },
      });

      for (const sub of pendingSubdomains) {
        await this.prisma.domain.update({
          where: { id: sub.id },
          data: { status: "ACTIVE" },
        });
        this.syncTraefikRouter({ ...sub, status: "ACTIVE" });
      }

      return {
        verified: true,
        status: "ACTIVE",
        message: "Domain verified successfully. Traefik traffic routing is active.",
        expectedRecord: expectedInstructions,
        detectedRecords,
      };
    } else {
      await this.prisma.domain.update({
        where: { id: domain.id },
        data: { status: "ERROR" },
      });

      return {
        verified: false,
        status: "ERROR",
        message: `TXT record verification failed. Could not find "${expectedValue}" on "${expectedInstructions.recordName}".`,
        expectedRecord: expectedInstructions,
        detectedRecords,
      };
    }
  }

  /**
   * Deletes a domain, cleans up Traefik router configuration for both the domain
   * and any child subdomains, and removes DB records.
   */
  public async delete(userId: string, domainId: string): Promise<{ success: boolean }> {
    const domain = await this.prisma.domain.findFirst({
      where: { id: domainId, userId },
    });

    if (!domain) {
      throw new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404);
    }

    // Clean up dynamic Traefik file for child subdomains
    const subdomains = await this.prisma.domain.findMany({
      where: { parentId: domain.id },
      select: { id: true },
    });
    for (const sub of subdomains) {
      this.removeTraefikRouter(sub.id);
    }

    // Clean up dynamic Traefik file for main domain
    this.removeTraefikRouter(domain.id);

    // Clean up CoreDNS zone file on disk
    const cleanHost = domain.hostname.startsWith("*.") ? domain.hostname.slice(2) : domain.hostname;
    for (const base of ["docker/coredns/zones", "../../docker/coredns/zones", "../docker/coredns/zones"]) {
      const zonePath = path.resolve(process.cwd(), base, `${cleanHost}.db`);
      if (fs.existsSync(zonePath)) {
        try {
          fs.unlinkSync(zonePath);
        } catch {
          // ignore
        }
      }
    }

    // Delete domain (cascades to subdomains and dnsRecords in database)
    await this.prisma.domain.delete({
      where: { id: domain.id },
    });

    await this.auditLog?.log(userId, "domain.deleted", { type: "Domain", id: domain.id }, {
      before: { hostname: domain.hostname },
    });

    return { success: true };
  }
}
