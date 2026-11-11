export function defaultTestMailSender(
  current: string,
  domains: ReadonlyArray<{ hostname: string; status: string }>,
): string {
  const activeHosts = domains.filter((domain) => domain.status === "ACTIVE")
    .map((domain) => domain.hostname.toLowerCase().replace(/^\*\./, ""));
  const sender = current.split("@").pop()?.toLowerCase() ?? "";
  if (activeHosts.some((host) => sender === host || sender.endsWith(`.${host}`))) {
    return current;
  }
  return activeHosts[0] ? `no-reply@${activeHosts[0]}` : "";
}
