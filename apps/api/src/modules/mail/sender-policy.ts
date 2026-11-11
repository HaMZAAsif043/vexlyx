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
