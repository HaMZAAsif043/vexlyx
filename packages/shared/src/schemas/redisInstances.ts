import { z } from "zod";

// ---------------------------------------------------------------------------
// Redis Instances (F5.30) — per-instance, password-protected Redis-compatible
// containers on the internal Docker network. One container per instance is the
// isolation boundary: Redis has no real multi-tenancy, so a shared server
// would let one tenant read or wipe another's keys.
// ---------------------------------------------------------------------------

export const RedisInstanceStatusEnum = z.enum(["CREATING", "RUNNING", "STOPPED", "ERROR"]);
export type RedisInstanceStatus = z.infer<typeof RedisInstanceStatusEnum>;

/**
 * Pinned image lines only — never `latest`. Valkey 8.x is BSD-licensed; the
 * Redis line stops at 7.2.x, the last pre-RSALv2/SSPL/AGPL release. The licence
 * decision is documented in docs/dev/redis-instances.md.
 */
export const RedisImageEnum = z.enum(["valkey/valkey:8.0", "redis:7.2-alpine"]);
export type RedisImage = z.infer<typeof RedisImageEnum>;

/** Cache-friendly presets shown in the create dialog; each maps to eviction + persistence defaults. */
export const RedisPresetEnum = z.enum(["cache", "queue", "persistent"]);
export type RedisPreset = z.infer<typeof RedisPresetEnum>;

export const RedisEvictionPolicyEnum = z.enum([
  "noeviction",
  "allkeys-lru",
  "volatile-lru",
  "allkeys-lfu",
  "volatile-lfu",
  "allkeys-random",
  "volatile-random",
  "volatile-ttl",
]);
export type RedisEvictionPolicy = z.infer<typeof RedisEvictionPolicyEnum>;

export const RedisPersistenceEnum = z.enum(["NONE", "RDB", "AOF"]);
export type RedisPersistence = z.infer<typeof RedisPersistenceEnum>;

/** Same naming rules as databases (F2.6): 2-63 chars, alphanumeric start. */
export const REDIS_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/;

export const CreateRedisInstanceSchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(63, "Name must be at most 63 characters")
    .regex(REDIS_NAME_PATTERN, "Name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens"),
  image: RedisImageEnum.default("valkey/valkey:8.0"),
  /** Preset only fills UI defaults for eviction/persistence; the resolved values are sent explicitly. */
  evictionPolicy: RedisEvictionPolicyEnum.default("noeviction"),
  persistence: RedisPersistenceEnum.default("RDB"),
  memoryLimitMb: z.coerce
    .number()
    .int("Memory limit must be a whole number of MB")
    .min(16, "Memory limit must be at least 16 MB")
    .default(64),
  projectId: z.string().min(1).optional().nullable(),
  /** Inject REDIS_URL/REDIS_HOST/REDIS_PORT into the linked project's env vars (F1.7). */
  autoInjectEnv: z.boolean().default(true),
});
export type CreateRedisInstanceInput = z.infer<typeof CreateRedisInstanceSchema>;

export const UpdateRedisInstanceSchema = z
  .object({
    memoryLimitMb: z.coerce
      .number()
      .int("Memory limit must be a whole number of MB")
      .min(16, "Memory limit must be at least 16 MB")
      .optional(),
    evictionPolicy: RedisEvictionPolicyEnum.optional(),
    persistence: RedisPersistenceEnum.optional(),
  })
  .refine((v) => v.memoryLimitMb !== undefined || v.evictionPolicy !== undefined || v.persistence !== undefined, {
    message: "At least one of memoryLimitMb, evictionPolicy or persistence must be provided",
  });
export type UpdateRedisInstanceInput = z.infer<typeof UpdateRedisInstanceSchema>;

export const RedisInstanceListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  search: z.string().max(100).optional(),
});
export type RedisInstanceListQuery = z.infer<typeof RedisInstanceListQuerySchema>;

// Response shapes — the password (and therefore the connection URL) is NEVER
// part of list responses; it is only revealed by the detail endpoint.

export interface RedisInstanceSummary {
  id: string;
  name: string;
  image: string;
  status: "CREATING" | "RUNNING" | "STOPPED" | "ERROR";
  memoryLimitMb: number;
  evictionPolicy: string;
  persistence: "NONE" | "RDB" | "AOF";
  containerName: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RedisInstanceDetail extends RedisInstanceSummary {
  /** Internal-only connection URL (redis://:password@container:6379). Detail endpoint only. */
  connectionUrl: string;
  port: number;
}

export interface RedisInstanceStats {
  usedMemoryBytes: number;
  /** Percent of maxmemory currently in use; null when the instance reports no maxmemory. */
  usedMemoryPercent: number | null;
  connectedClients: number;
  totalKeys: number;
  evictedKeys: number;
  uptimeSeconds: number;
}

export interface RedisInstanceListResponse {
  instances: RedisInstanceSummary[];
}
