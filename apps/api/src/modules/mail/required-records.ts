import dns from "node:dns/promises";
import { PUBLIC_RESOLVER_IPS } from "../domains/resolvers.js";

export type MailRecordPurpose = "MX" | "HOST" | "SPF" | "DKIM" | "DMARC";

export interface RequiredMailRecord {
  purpose: MailRecordPurpose;
  type: "TXT" | "MX" | "A";
  name: string;
  value: string;
  priority?: number;
}

export interface LiveMailRecordRow {
  type: string;
  name: string;
  value: string;
  priority: number | null;
}

export function buildMailRoutingRecords(
  mailDomain: string,
  mailHostname: string,
  serverIp: string,
): RequiredMailRecord[] {
  const normalizedDomain = mailDomain.replace(/\.$/, "").toLowerCase();
  const normalizedHostname = mailHostname.replace(/\.$/, "").toLowerCase();
  const suffix = `.${normalizedDomain}`;
  const hostName = normalizedHostname.endsWith(suffix)
    ? normalizedHostname.slice(0, -suffix.length)
    : normalizedHostname;

  return [
    {
      purpose: "MX",
      type: "MX",
      name: "@",
      value: normalizedHostname,
      priority: 10,
    },
    { purpose: "HOST", type: "A", name: hostName, value: serverIp },
  ];
}

const unquote = (value: string) => value.replace(/^"|"$/g, "").trim();
const compact = (value: string) => value.replace(/\s+/g, "");

function dkimKeyOf(value: string): string {
  return /p=([A-Za-z0-9+/=]+)/.exec(compact(unquote(value)))?.[1] ?? "";
}

/**
 * The records a domain needs for deliverable mail. Single source of truth for
 * both MANAGED (written to the zone) and CONNECTED (shown to add at a registrar).
 */
export function buildRequiredMailRecords(
  hostname: string,
  serverIp: string,
  dkim?: { selector: string; value: string },
): RequiredMailRecord[] {
  const records: RequiredMailRecord[] = [
    ...buildMailRoutingRecords(hostname, `mail.${hostname}`, serverIp),
    {
      purpose: "SPF",
      type: "TXT",
      name: "@",
      value: `v=spf1 mx a ip4:${serverIp} ~all`,
    },
    {
      purpose: "DMARC",
      type: "TXT",
      name: "_dmarc",
      value: `v=DMARC1; p=none; rua=mailto:postmaster@${hostname}; pct=100`,
    },
  ];
  if (dkim) {
    records.push({
      purpose: "DKIM",
      type: "TXT",
      name: `${dkim.selector}._domainkey`,
      value: dkim.value,
    });
  }
  return records;
}

async function resolveAcross<T>(
  lookup: (resolver: dns.Resolver) => Promise<T[]>,
): Promise<T[]> {
  const perResolver = await Promise.all(
    PUBLIC_RESOLVER_IPS.map(async (ip) => {
      try {
        const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
        resolver.setServers([ip]);
        return await lookup(resolver);
      } catch {
        // Record absent or resolver unreachable — another resolver may still answer
        return [];
      }
    }),
  );
  return perResolver.flat();
}

/**
 * Looks up what is actually published in public DNS for a CONNECTED domain,
 * shaped like DnsRecord rows so it can feed the same scoring logic as MANAGED
 * domains. Any valid SPF/DMARC/MX counts (users may have their own); DKIM must
 * carry the same public key we generated.
 */
export async function lookupLiveMailRecords(
  hostname: string,
  required: RequiredMailRecord[],
): Promise<LiveMailRecordRow[]> {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.VEXLYX_MOCK_DNS === "true"
  ) {
    return required.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority ?? null,
    }));
  }

  const fqdn = (name: string) =>
    name === "@" ? hostname : `${name}.${hostname}`;
  const txt = async (name: string): Promise<string[]> =>
    resolveAcross(async (resolver) =>
      (await resolver.resolveTxt(fqdn(name))).map((chunks) => chunks.join("")),
    );

  const rows: LiveMailRecordRow[] = [];

  const [apexTxt, dmarcTxt, mx, mailHostIps] = await Promise.all([
    txt("@"),
    txt("_dmarc"),
    resolveAcross(async (resolver) => resolver.resolveMx(hostname)),
    resolveAcross(async (resolver) => resolver.resolve4(fqdn("mail"))),
  ]);

  // Only an A record pointing at this server counts — mail must reach us.
  const expectedIp = required.find((r) => r.purpose === "HOST")?.value;
  for (const ip of new Set(mailHostIps)) {
    if (ip === expectedIp)
      rows.push({ type: "A", name: "mail", value: ip, priority: null });
  }

  for (const value of new Set(apexTxt)) {
    if (value.startsWith("v=spf1"))
      rows.push({ type: "TXT", name: "@", value, priority: null });
  }
  for (const value of new Set(dmarcTxt)) {
    if (value.startsWith("v=DMARC1"))
      rows.push({ type: "TXT", name: "_dmarc", value, priority: null });
  }
  for (const record of mx) {
    rows.push({
      type: "MX",
      name: "@",
      value: record.exchange,
      priority: record.priority,
    });
  }

  const dkim = required.find((r) => r.purpose === "DKIM");
  if (dkim) {
    const expectedKey = dkimKeyOf(dkim.value);
    for (const value of new Set(await txt(dkim.name))) {
      if (expectedKey && dkimKeyOf(value) === expectedKey) {
        rows.push({ type: "TXT", name: dkim.name, value, priority: null });
      }
    }
  }

  return rows;
}

/** A required record is "live" when the lookup found a row serving its purpose. */
export function isRecordLive(
  record: RequiredMailRecord,
  live: LiveMailRecordRow[],
): boolean {
  switch (record.purpose) {
    case "MX":
      return live.some((r) => r.type === "MX");
    case "HOST":
      return live.some((r) => r.type === "A" && r.name === "mail");
    case "SPF":
      return live.some((r) => r.type === "TXT" && r.name === "@");
    case "DMARC":
      return live.some((r) => r.type === "TXT" && r.name === "_dmarc");
    case "DKIM":
      return live.some((r) => r.type === "TXT" && r.name === record.name);
  }
}
