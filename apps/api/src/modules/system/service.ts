import dns from "node:dns";
import type { PrismaClient } from "@prisma/client";
import type {
  DnsOnboardingInfoResponse,
  DnsRecordSuggestion,
  DnsResolverCheckResult,
  DnsRecordVerification,
  DnsVerificationResponse,
  SystemSettingsResponse,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { buildMailRoutingRecords } from "../mail/required-records.js";

// Same public resolvers domains/dns-service.ts's checkPropagation() queries,
// for the same reason: a single resolver's cache can be stale or geographically
// biased, so checking a few gives a more honest "has this actually propagated"
// answer than trusting whichever resolver Node's default happens to pick.
const PUBLIC_RESOLVERS = [
  { name: "Cloudflare (1.1.1.1)", ip: "1.1.1.1" },
  { name: "Google (8.8.8.8)", ip: "8.8.8.8" },
  { name: "Quad9 (9.9.9.9)", ip: "9.9.9.9" },
];

export class SystemService {
  constructor(private prisma: PrismaClient) {}

  // Server timezone setting (F5.13). Defaults to the server OS's own detected
  // timezone on first read (rather than a hardcoded "UTC"), since that's the
  // value an admin who never touches this setting would actually want.
  async getSettings(): Promise<SystemSettingsResponse> {
    const existing = await this.prisma.systemSettings.findUnique({
      where: { id: "default" },
    });
    if (existing) {
      return {
        timezone: existing.timezone,
        updatedAt: existing.updatedAt.toISOString(),
      };
    }

    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const created = await this.prisma.systemSettings.create({
      data: { id: "default", timezone: detected },
    });
    return {
      timezone: created.timezone,
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  async updateSettings(timezone: string): Promise<SystemSettingsResponse> {
    const updated = await this.prisma.systemSettings.upsert({
      where: { id: "default" },
      create: { id: "default", timezone },
      update: { timezone },
    });
    return {
      timezone: updated.timezone,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  // Builds the DNS/IP reference info an admin needs to point their domain(s)
  // at this server (F5.9). Returns an empty record list — rather than
  // guessing — whenever the domain or public IP isn't known, since a
  // half-correct record list is worse than none.
  getDnsOnboardingInfo(): DnsOnboardingInfoResponse {
    const domain = env.PANEL_DOMAIN ?? null;
    const publicIp = env.PUBLIC_IP ?? null;
    const baseDomain = env.BASE_DOMAIN;

    const records: DnsRecordSuggestion[] = [];
    if (domain && publicIp) {
      records.push({
        type: "A",
        host: domain,
        value: publicIp,
        purpose: "Panel",
      });
      // The dashboard's browser JS calls https://api.<domain> directly
      // (NEXT_PUBLIC_API_URL, docker-compose.prod.yml) — this only happens to
      // work without its own record when baseDomain === domain, since the
      // wildcard below then incidentally covers it too. With a split base
      // domain (VEXLYX_BASE_DOMAIN != VEXLYX_DOMAIN) the wildcard lives in a
      // different zone entirely, so the API needs an explicit record either way.
      records.push({
        type: "A",
        host: `api.${domain}`,
        value: publicIp,
        purpose: "API",
      });
      records.push({
        type: "A",
        host: `webmail.${domain}`,
        value: publicIp,
        purpose: "Webmail",
      });
      records.push({
        type: "A",
        host: `*.${baseDomain}`,
        value: publicIp,
        purpose: "Deployed project subdomains",
      });
      if (env.HOSTED_MAIL_HOSTNAME && env.HOSTED_MAIL_DOMAIN) {
        const mailHostname = env.HOSTED_MAIL_HOSTNAME;
        const mailDomain = env.HOSTED_MAIL_DOMAIN;
        const mailRecords = buildMailRoutingRecords(
          mailDomain,
          mailHostname,
          publicIp,
        );
        records.push(
          ...mailRecords.map((record): DnsRecordSuggestion => ({
            type: record.type as "A" | "MX",
            host: record.purpose === "HOST" ? mailHostname : mailDomain,
            value: record.value,
            priority: record.priority,
            purpose:
              record.purpose === "HOST"
                ? "Inbound mail server"
                : "Inbound mail routing",
          })),
        );
      }
    }

    return { publicIp, domain, baseDomain, records };
  }

  // Live-checks each onboarding record against a few public resolvers (F5.11
  // UX follow-up) — "is this actually pointed at the server yet?" instead of
  // just listing what's needed. A wildcard record (`*.example.com`) can't be
  // queried literally, so a fixed probe subdomain under the same zone is
  // queried instead — if the wildcard is live, the probe resolves the same way.
  async verifyDnsRecords(): Promise<DnsVerificationResponse> {
    const { records } = this.getDnsOnboardingInfo();

    const results = await Promise.all(
      records.map((record) => this.verifyOneRecord(record)),
    );

    return { checkedAt: new Date().toISOString(), results };
  }

  private async verifyOneRecord(
    record: DnsRecordSuggestion,
  ): Promise<DnsRecordVerification> {
    const checkedHost = record.host.startsWith("*.")
      ? `vexlyx-dns-check.${record.host.slice(2)}`
      : record.host;

    const resolverResults: DnsResolverCheckResult[] = await Promise.all(
      PUBLIC_RESOLVERS.map(async (r): Promise<DnsResolverCheckResult> => {
        try {
          const resolver = new dns.promises.Resolver();
          resolver.setServers([r.ip]);
          const detectedValues =
            record.type === "MX"
              ? (await resolver.resolveMx(checkedHost)).map(
                  (mx) =>
                    `${mx.priority} ${mx.exchange.replace(/\.$/, "").toLowerCase()}`,
                )
              : await resolver.resolve4(checkedHost);
          const expected =
            record.type === "MX"
              ? `${record.priority ?? 10} ${record.value.replace(/\.$/, "").toLowerCase()}`
              : record.value;
          const isMatch = detectedValues.includes(expected);
          return {
            resolver: r.name,
            status: isMatch
              ? "MATCH"
              : detectedValues.length > 0
                ? "MISMATCH"
                : "NOT_FOUND",
            detectedValues,
          };
        } catch (err: unknown) {
          const errCode = (err as { code?: string })?.code;
          return {
            resolver: r.name,
            status:
              errCode === "ENOTFOUND" || errCode === "ENODATA"
                ? "NOT_FOUND"
                : "ERROR",
            detectedValues: [],
          };
        }
      }),
    );

    return {
      type: record.type,
      host: record.host,
      checkedHost,
      expected: record.value,
      isPropagated:
        resolverResults.length > 0 &&
        resolverResults.every((r) => r.status === "MATCH"),
      resolvers: resolverResults,
    };
  }
}
