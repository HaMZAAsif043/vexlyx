const ORIGIN_NOT_ALLOWED = "ORIGIN_NOT_ALLOWED";

type NodeEnvironment = "development" | "production" | "test";
type OriginCallback = (error: Error | null, allowed?: boolean) => void;

interface SocketOriginPolicy {
  configuredOrigin: string;
  nodeEnvironment: NodeEnvironment;
}

function parseHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSocketOriginAllowed(
  origin: string | undefined,
  policy: SocketOriginPolicy,
): boolean {
  // Non-browser clients commonly omit Origin. They remain subject to the same
  // mandatory, Redis-backed session authentication as browser connections.
  if (origin === undefined) return true;

  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin) return false;

  if (policy.nodeEnvironment !== "production") return true;

  return parsedOrigin === parseHttpOrigin(policy.configuredOrigin);
}

export function createSocketOriginHandler(policy: SocketOriginPolicy) {
  return (origin: string | undefined, callback: OriginCallback): void => {
    if (isSocketOriginAllowed(origin, policy)) {
      callback(null, true);
      return;
    }

    callback(new Error(ORIGIN_NOT_ALLOWED));
  };
}
