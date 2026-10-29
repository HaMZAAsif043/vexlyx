export const DEV_REDIS_PASSWORD = "vexlyx_dev";
export const DEV_REDIS_URL = `redis://:${DEV_REDIS_PASSWORD}@localhost:6379`;

export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

function decode(part: string): string | undefined {
  return part ? decodeURIComponent(part) : undefined;
}

/**
 * Turns a REDIS_URL into the connection options BullMQ expects, credentials
 * included. BullMQ opens its own connections, so it cannot take the URL itself.
 * @param redisUrl - A redis:// or rediss:// URL, e.g. redis://:password@redis:6379
 * @throws Error if the URL is malformed or not a Redis URL
 */
export function parseRedisUrl(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must start with redis:// or rediss://");
  }

  const username = decode(url.username);
  const password = decode(url.password);
  const db = Number(url.pathname.slice(1));

  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(Number.isInteger(db) && db > 0 ? { db } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function redisUrlHasPassword(redisUrl: string): boolean {
  try {
    return Boolean(parseRedisUrl(redisUrl).password);
  } catch {
    return false;
  }
}
