import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient, RedisInstance } from "@prisma/client";
import { env } from "../../config/env.js";
import { encrypt, decrypt } from "../../utils/encryption.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import { EnvService } from "../env/service.js";
import type { AuditLogService } from "../audit-log/service.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "../../utils/processWatchdog.js";
import type {
  CreateRedisInstanceInput,
  UpdateRedisInstanceInput,
  RedisInstanceListQuery,
  RedisInstanceSummary,
  RedisInstanceDetail,
  RedisInstanceStats,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Error Class
// ---------------------------------------------------------------------------

export class RedisInstanceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "RedisInstanceError";
  }
}

// ---------------------------------------------------------------------------
// Locate redis_manager.py
// ---------------------------------------------------------------------------

function getRedisManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/redis_manager.py"),
    resolve(currentDir, "../../../../system/python/redis_manager.py"),
    resolve(process.cwd(), "../../system/python/redis_manager.py"),
    resolve(process.cwd(), "system/python/redis_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

// ---------------------------------------------------------------------------
// Spawn redis_manager.py (JSON on stdin, JSON on stdout)
// ---------------------------------------------------------------------------

function runPythonCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptPath = getRedisManagerScriptPath();
    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.redis, (ms) =>
      rejectPromise(
        new RedisInstanceError(
          `Redis instance manager timed out after ${ms / 1000}s`,
          "SCRIPT_TIMEOUT",
          504,
        ),
      ),
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const raw = stdout.trim();
      if (!raw) {
        rejectPromise(
          new RedisInstanceError(
            `redis_manager.py produced no output (stderr: ${stderr.trim()})`,
            "REDIS_SYSTEM_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        rejectPromise(
          new RedisInstanceError(
            `redis_manager.py returned invalid JSON: ${raw}`,
            "REDIS_SYSTEM_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed.error || code !== 0) {
        rejectPromise(
          new RedisInstanceError(
            (parsed.error as string) || "System redis script failed",
            (parsed.code as string) || "REDIS_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolvePromise(parsed as T);
    });

    child.on("error", (err) => {
      rejectPromise(
        new RedisInstanceError(
          `Failed to spawn system redis manager: ${err.message}`,
          "REDIS_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Alphanumeric only — redis_manager.py writes this verbatim into redis.conf. */
function generateSecurePassword(length = 32): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

/** Compose-independent unique container name — never derived from the bare
 * user-visible name alone (the F5.21 "bare service name" collision class). */
function generateContainerName(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "instance";
  return `vexlyx-redis-${slug}-${randomBytes(6).toString("hex")}`;
}

const REDIS_PORT = 6379;

export class RedisInstanceService {
  private envService: EnvService;

  constructor(
    private prisma: PrismaClient,
    private auditLog?: AuditLogService,
  ) {
    this.envService = new EnvService(prisma);
  }

  private buildConnectionUrl(record: Pick<RedisInstance, "containerName">, plainPassword: string): string {
    return `redis://:${plainPassword}@${record.containerName}:${REDIS_PORT}`;
  }

  private formatSummary(
    record: RedisInstance & { project?: { id: string; name: string } | null },
  ): RedisInstanceSummary {
    return {
      id: record.id,
      name: record.name,
      image: record.imageTag,
      status: record.status,
      memoryLimitMb: record.memoryLimitMb,
      evictionPolicy: record.evictionPolicy,
      persistence: record.persistence,
      containerName: record.containerName,
      projectId: record.projectId,
      projectName: record.project?.name ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private formatDetail(
    record: RedisInstance & { project?: { id: string; name: string } | null },
    plainPassword: string,
  ): RedisInstanceDetail {
    return {
      ...this.formatSummary(record),
      connectionUrl: this.buildConnectionUrl(record, plainPassword),
      port: REDIS_PORT,
    };
  }

  private decryptPassword(record: Pick<RedisInstance, "passwordEncrypted">): string {
    try {
      return decrypt(record.passwordEncrypted);
    } catch {
      throw new RedisInstanceError(
        "Stored password could not be decrypted; rotate the password to repair this instance",
        "DECRYPTION_ERROR",
        500,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(userId: string, input: CreateRedisInstanceInput): Promise<RedisInstanceDetail> {
    await assertUnderQuota(
      this.prisma,
      userId,
      "redisInstance",
      (message, code, statusCode) => new RedisInstanceError(message, code, statusCode),
    );

    const existing = await this.prisma.redisInstance.findUnique({
      where: { userId_name: { userId, name: input.name } },
    });
    if (existing) {
      throw new RedisInstanceError(
        `An instance named '${input.name}' already exists`,
        "REDIS_NAME_CONFLICT",
        409,
      );
    }

    if (input.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: input.projectId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!project) {
        throw new RedisInstanceError("Project not found", "PROJECT_NOT_FOUND", 404);
      }
    }

    if (input.memoryLimitMb > env.REDIS_INSTANCE_MAX_MEMORY_MB) {
      throw new RedisInstanceError(
        `Memory limit exceeds the maximum of ${env.REDIS_INSTANCE_MAX_MEMORY_MB} MB`,
        "REDIS_MEMORY_LIMIT_TOO_HIGH",
        400,
      );
    }

    const plainPassword = generateSecurePassword();
    const containerName = generateContainerName(input.name);

    await runPythonCommand({
      command: "create_instance",
      containerName,
      image: input.image,
      password: plainPassword,
      memoryLimitMb: input.memoryLimitMb,
      evictionPolicy: input.evictionPolicy,
      persistence: input.persistence,
    });

    let record: RedisInstance;
    try {
      record = await this.prisma.redisInstance.create({
        data: {
          name: input.name,
          containerName,
          imageTag: input.image,
          memoryLimitMb: input.memoryLimitMb,
          evictionPolicy: input.evictionPolicy,
          persistence: input.persistence,
          passwordEncrypted: encrypt(plainPassword),
          status: "RUNNING",
          userId,
          projectId: input.projectId ?? null,
        },
        include: { project: { select: { id: true, name: true } } },
      });
    } catch (err) {
      // The container is already running; never leave it orphaned behind a
      // failed row insert (the F5.21 teardown bug class, in reverse).
      await runPythonCommand({
        command: "delete_instance",
        containerName,
      }).catch(() => undefined);
      throw err;
    }

    void notifyQuotaThreshold(this.prisma, userId, "redisInstance");

    if (input.projectId && input.autoInjectEnv !== false) {
      const connectionUrl = this.buildConnectionUrl(record, plainPassword);
      await this.envService.bulkUpsert(userId, input.projectId, [
        { key: "REDIS_URL", value: connectionUrl },
        { key: "REDIS_HOST", value: containerName },
        { key: "REDIS_PORT", value: String(REDIS_PORT) },
      ]);
    }

    await this.auditLog?.log(
      userId,
      "redis_instance.created",
      { type: "RedisInstance", id: record.id },
      {
        after: {
          name: record.name,
          image: record.imageTag,
          memoryLimitMb: record.memoryLimitMb,
          evictionPolicy: record.evictionPolicy,
          persistence: record.persistence,
        },
      },
    );

    return this.formatDetail(record, plainPassword);
  }

  // -------------------------------------------------------------------------
  // List / get
  // -------------------------------------------------------------------------

  async list(userId: string, query: RedisInstanceListQuery): Promise<RedisInstanceSummary[]> {
    const records = await this.prisma.redisInstance.findMany({
      where: {
        userId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}),
      },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return records.map((record) => this.formatSummary(record));
  }

  /** ADMIN-only: every instance on the panel (summaries, never passwords). */
  async listAll(): Promise<RedisInstanceSummary[]> {
    const records = await this.prisma.redisInstance.findMany({
      include: { project: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    return records.map((record) => this.formatSummary(record));
  }

  /** Ownership check: other users' instances 404 (existence hidden); ADMIN may read any. */
  private async findOwned(id: string, userId: string, isAdmin = false) {
    const record = await this.prisma.redisInstance.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!record || (record.userId !== userId && !isAdmin)) {
      throw new RedisInstanceError("Redis instance not found", "REDIS_INSTANCE_NOT_FOUND", 404);
    }
    return record;
  }

  async get(id: string, userId: string, isAdmin = false): Promise<RedisInstanceDetail> {
    const record = await this.findOwned(id, userId, isAdmin);
    return this.formatDetail(record, this.decryptPassword(record));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private async setPowerState(id: string, userId: string, action: "start" | "stop" | "restart", isAdmin = false) {
    const record = await this.findOwned(id, userId, isAdmin);

    await runPythonCommand({
      command: `${action}_instance`,
      containerName: record.containerName,
    });

    const status = action === "stop" ? "STOPPED" : "RUNNING";
    const updated = await this.prisma.redisInstance.update({
      where: { id: record.id },
      data: { status },
      include: { project: { select: { id: true, name: true } } },
    });
    return this.formatSummary(updated);
  }

  start(id: string, userId: string, isAdmin = false) {
    return this.setPowerState(id, userId, "start", isAdmin);
  }

  stop(id: string, userId: string, isAdmin = false) {
    return this.setPowerState(id, userId, "stop", isAdmin);
  }

  restart(id: string, userId: string, isAdmin = false) {
    return this.setPowerState(id, userId, "restart", isAdmin);
  }

  // -------------------------------------------------------------------------
  // Update limits / rotate password (both recreate the container, same volume)
  // -------------------------------------------------------------------------

  async update(id: string, userId: string, input: UpdateRedisInstanceInput, isAdmin = false): Promise<RedisInstanceDetail> {
    const record = await this.findOwned(id, userId, isAdmin);

    const memoryLimitMb = input.memoryLimitMb ?? record.memoryLimitMb;
    if (memoryLimitMb > env.REDIS_INSTANCE_MAX_MEMORY_MB) {
      throw new RedisInstanceError(
        `Memory limit exceeds the maximum of ${env.REDIS_INSTANCE_MAX_MEMORY_MB} MB`,
        "REDIS_MEMORY_LIMIT_TOO_HIGH",
        400,
      );
    }
    const evictionPolicy = input.evictionPolicy ?? record.evictionPolicy;
    const persistence = input.persistence ?? record.persistence;

    const plainPassword = this.decryptPassword(record);
    await runPythonCommand({
      command: "recreate_instance",
      containerName: record.containerName,
      image: record.imageTag,
      password: plainPassword,
      memoryLimitMb,
      evictionPolicy,
      persistence,
    });

    const updated = await this.prisma.redisInstance.update({
      where: { id: record.id },
      data: { memoryLimitMb, evictionPolicy, persistence, status: "RUNNING" },
      include: { project: { select: { id: true, name: true } } },
    });

    await this.auditLog?.log(
      userId,
      "redis_instance.updated",
      { type: "RedisInstance", id: record.id },
      {
        before: {
          memoryLimitMb: record.memoryLimitMb,
          evictionPolicy: record.evictionPolicy,
          persistence: record.persistence,
        },
        after: { memoryLimitMb, evictionPolicy, persistence },
      },
    );

    return this.formatDetail(updated, plainPassword);
  }

  async rotatePassword(id: string, userId: string, isAdmin = false): Promise<RedisInstanceDetail> {
    const record = await this.findOwned(id, userId, isAdmin);

    const plainPassword = generateSecurePassword();
    await runPythonCommand({
      command: "recreate_instance",
      containerName: record.containerName,
      image: record.imageTag,
      password: plainPassword,
      memoryLimitMb: record.memoryLimitMb,
      evictionPolicy: record.evictionPolicy,
      persistence: record.persistence,
    });

    const updated = await this.prisma.redisInstance.update({
      where: { id: record.id },
      data: { passwordEncrypted: encrypt(plainPassword), status: "RUNNING" },
      include: { project: { select: { id: true, name: true } } },
    });

    // Audit deliberately carries no secret material — only the fact it happened.
    await this.auditLog?.log(
      userId,
      "redis_instance.password_rotated",
      { type: "RedisInstance", id: record.id },
      { after: { name: record.name } },
    );

    return this.formatDetail(updated, plainPassword);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async stats(id: string, userId: string, isAdmin = false): Promise<RedisInstanceStats> {
    const record = await this.findOwned(id, userId, isAdmin);

    if (record.status !== "RUNNING") {
      throw new RedisInstanceError(
        "Instance is not running",
        "REDIS_NOT_RUNNING",
        409,
      );
    }

    const result = await runPythonCommand<RedisInstanceStats>({
      command: "stats_instance",
      containerName: record.containerName,
    });

    return {
      usedMemoryBytes: Number(result.usedMemoryBytes ?? 0),
      usedMemoryPercent:
        result.usedMemoryPercent === null || result.usedMemoryPercent === undefined
          ? null
          : Number(result.usedMemoryPercent),
      connectedClients: Number(result.connectedClients ?? 0),
      totalKeys: Number(result.totalKeys ?? 0),
      evictedKeys: Number(result.evictedKeys ?? 0),
      uptimeSeconds: Number(result.uptimeSeconds ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async delete(id: string, userId: string, isAdmin = false): Promise<{ success: true; id: string }> {
    const record = await this.findOwned(id, userId, isAdmin);

    // Tear down container + volume first; only drop the row once the engine
    // confirms, so a live instance is never orphaned behind a deleted record.
    try {
      await runPythonCommand({
        command: "delete_instance",
        containerName: record.containerName,
      });
    } catch (err) {
      if (err instanceof RedisInstanceError) {
        throw new RedisInstanceError(
          `Failed to remove instance '${record.name}': ${err.message}`,
          "REDIS_TEARDOWN_FAILED",
          502,
        );
      }
      throw err;
    }

    await this.prisma.redisInstance.delete({ where: { id: record.id } });

    await this.auditLog?.log(
      userId,
      "redis_instance.deleted",
      { type: "RedisInstance", id: record.id },
      { before: { name: record.name, image: record.imageTag } },
    );

    return { success: true, id: record.id };
  }
}
