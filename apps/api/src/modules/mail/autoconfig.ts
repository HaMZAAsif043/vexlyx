import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";

export const AUTOCONFIG_PATH = "/.well-known/autoconfig/mail/config-v1.1.xml";

export function normalizeMailHostname(value: string): string | null {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (
    hostname !== hostname.trim() ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      hostname,
    )
  )
    return null;
  return hostname;
}

const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );

export function renderMailAutoconfig(domain: string, hostname: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${xml(domain)}">
    <domain>${xml(domain)}</domain>
    <displayName>${xml(domain)} Mail</displayName>
    <displayShortName>${xml(domain)}</displayShortName>
    <incomingServer type="imap">
      <hostname>${xml(hostname)}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${xml(hostname)}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;
}

/** Public provider settings only; never queries or discloses mailbox existence. */
export async function mailAutoconfigRoutes(app: FastifyInstance) {
  app.get(AUTOCONFIG_PATH, async (request, reply) => {
    // Use the actual Host, never a client-supplied forwarding header or email query.
    const hostname = normalizeMailHostname(
      (request.headers.host ?? "").replace(/:\d+$/, ""),
    );
    const domain =
      hostname &&
      (await app.prisma.domain.findFirst({
        where: { hostname, status: "ACTIVE", parentId: null },
        select: { hostname: true },
      }));
    reply.header("Cache-Control", "no-store");
    if (!domain)
      return reply.code(404).send({ error: "Mail configuration unavailable" });
    const mailHost =
      env.HOSTED_MAIL_HOSTNAME &&
      normalizeMailHostname(env.HOSTED_MAIL_HOSTNAME);
    if (!mailHost)
      return reply.code(503).send({ error: "Mail hostname is not configured" });
    return reply
      .type("application/xml; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .send(renderMailAutoconfig(domain.hostname, mailHost));
  });
}
