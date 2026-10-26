import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, type PrismaClient, type RedisInstance } from "@prisma/client";
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
    let result: Record<string, unknown> | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Parse stdout line-by-line and keep the last result object, so any
      // stray progress line ({"log": ...}) can never corrupt the outcome
      // (same contract as the backups/cleanup runners). redis_manager.py
      // itself keeps stdout to a single JSON document; progress goes to
      // stderr.
      let newlineIndex: number;
      while ((newlineIndex = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed && typeof parsed === "object" && "log" in parsed) continue;
        if (parsed && typeof parsed === "object") {
          result = parsed as Record<string, unknown>;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      // Flush a trailing line that had no terminating newline.
      const trailing = stdout.trim();
      if (trailing) {
        try {
          const parsed: unknown = JSON.parse(trailing);
          if (parsed && typeof parsed === "object" && !("log" in parsed)) {
            result = parsed as Record<string, unknown>;
          }
        } catch {
          // Ignore a trailing partial line.
        }
      }

      if (result === null) {
        rejectPromise(
          new RedisInstanceError(
            code === 0
              ? `redis_manager.py produced no JSON result (stderr: ${stderr.trim()})`
              : `redis_manager.py failed before producing a result (exit ${code}, stderr: ${stderr.trim()})`,
            "REDIS_SYSTEM_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      if (result.error || code !== 0) {
        rejectPromise(
          new RedisInstanceError(
            (result.error as string) || "System redis script failed",
            (result.code as string) || "REDIS_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolvePromise(result as T);
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

/**
 * Quota-slot reservation runs as a Serializable interactive transaction and is
 * retried on serialization conflicts (P2034) / transaction timeouts (P2028):
 * two concurrent creates seeing the same last free slot surface as one of
 * these errors, and the retry re-counts and then correctly fails with
 * QUOTA_EXCEEDED. The retry budget is small — a genuine conflict resolves on
 * the first re-count.
 */
const RESERVE_TX_RETRIES = 3;

function prismaErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  return undefined;
}

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
    // Fast pre-check for a friendly error; the authoritative check happens
    // atomically inside the reservation transaction below.
    await assertUnderQuota(
      this.prisma,
      userId,
      "redisInstance",
      (message, code, statusCode) => new RedisInstanceError(message, code, statusCode),
    );

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

    // Reserve the quota slot (and the row) atomically BEFORE Docker runs —
    // see reserveInstance() for why this is a Serializable transaction.
    const record = await this.reserveInstance(userId, input, containerName, plainPassword);

    try {
      await runPythonCommand({
        command: "create_instance",
        containerName,
        image: input.image,
        password: plainPassword,
        memoryLimitMb: input.memoryLimitMb,
        evictionPolicy: input.evictionPolicy,
        persistence: input.persistence,
      });
    } catch (err) {
      // Roll back the reservation and any resources the attempt may have left
      // (the script cleans up after itself, but a timed-out kill can strand a
      // container). delete_instance is idempotent, and rollback failures are
      // reported — never swallowed — with the container name, the only handle
      // left for manual cleanup.
      try {
        await runPythonCommand({ command: "delete_instance", containerName });
      } catch (cleanupErr) {
        console.error(
          `[RedisInstanceService] Create of '${input.name}' failed and rollback of container '${containerName}' also failed; remove the container manually:`,
          cleanupErr,
        );
      }
      await this.releaseReservation(record.id, containerName);
      throw err;
    }

    let updated: RedisInstance;
    try {
      updated = await this.prisma.redisInstance.update({
        where: { id: record.id },
        data: { status: "RUNNING" },
        include: { project: { select: { id: true, name: true } } },
      });
    } catch (err) {
      // The container is up and the row exists; a failed status update only
      // leaves a visible CREATING row the user can retry or delete.
      console.error(
        `[RedisInstanceService] Container '${containerName}' was created but instance '${record.id}' could not be marked RUNNING:`,
        err,
      );
      throw err;
    }

    void notifyQuotaThreshold(this.prisma, userId, "redisInstance");

    if (input.projectId && input.autoInjectEnv !== false) {
      const connectionUrl = this.buildConnectionUrl(updated, plainPassword);
      await this.envService.bulkUpsert(userId, input.projectId, [
        { key: "REDIS_URL", value: connectionUrl },
        { key: "REDIS_HOST", value: containerName },
        { key: "REDIS_PORT", value: String(REDIS_PORT) },
      ]);
    }

    await this.auditLog?.log(
      userId,
      "redis_instance.created",
      { type: "RedisInstance", id: updated.id },
      {
        after: {
          name: updated.name,
          image: updated.imageTag,
          memoryLimitMb: updated.memoryLimitMb,
          evictionPolicy: updated.evictionPolicy,
          persistence: updated.persistence,
        },
      },
    );

    return this.formatDetail(updated, plainPassword);
  }

  /**
   * Atomically checks the quota and inserts the instance row in one
   * Serializable transaction. The count-then-insert pair only guards against
   * concurrent creates (two requests seeing the same last free slot) if the
   * isolation level turns that write skew into a serialization failure, which
   * this method retries so the re-count sees the winner's committed row. No raw
   * SQL — Prisma enforces the isolation level. The row starts as CREATING and
   * acts as the slot reservation until provisioning flips it to RUNNING (or
   * deletes it again).
   */
  private async reserveInstance(
    userId: string,
    input: CreateRedisInstanceInput,
    containerName: string,
    plainPassword: string,
  ): Promise<RedisInstance> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await assertUnderQuota(tx as unknown as PrismaClient, userId, "redisInstance", (message, code, statusCode) =>
              new RedisInstanceError(message, code, statusCode),
            );
            const existing = await tx.redisInstance.findUnique({
              where: { userId_name: { userId, name: input.name } },
            });
            if (existing) {
              throw new RedisInstanceError(
                `An instance named '${input.name}' already exists`,
                "REDIS_NAME_CONFLICT",
                409,
              );
            }
            return tx.redisInstance.create({
              data: {
                name: input.name,
                containerName,
                imageTag: input.image,
                memoryLimitMb: input.memoryLimitMb,
                evictionPolicy: input.evictionPolicy,
                persistence: input.persistence,
                passwordEncrypted: encrypt(plainPassword),
                status: "CREATING",
                userId,
                projectId: input.projectId ?? null,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 },
        );
      } catch (err) {
        const code = prismaErrorCode(err);
        if ((code === "P2034" || code === "P2028") && attempt < RESERVE_TX_RETRIES) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * attempt));
          continue;
        }
        if (code === "P2002") {
          // Unique (userId, name) as the database-level backstop of the check above.
          throw new RedisInstanceError(
            `An instance named '${input.name}' already exists`,
            "REDIS_NAME_CONFLICT",
            409,
          );
        }
        throw err;
      }
    }
  }

  /** Drops a CREATING row after failed provisioning so the quota slot frees
   * up again; a failed release is reported with the row id so an admin can
   * clean it up (the row stays visible in the list). */
  private async releaseReservation(recordId: string, containerName: string): Promise<void> {
    try {
      await this.prisma.redisInstance.delete({ where: { id: recordId } });
    } catch (err) {
      console.error(
        `[RedisInstanceService] Failed to release instance reservation '${recordId}' (container '${containerName}') after a failed create; delete the row to free the quota slot:`,
        err,
      );
    }
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
    const oldPassword = this.decryptPassword(record);

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

    let updated: RedisInstance;
    try {
      updated = await this.prisma.redisInstance.update({
        where: { id: record.id },
        data: { passwordEncrypted: encrypt(plainPassword), status: "RUNNING" },
        include: { project: { select: { id: true, name: true } } },
      });
    } catch (err) {
      // The container already requires the new password while the record
      // still holds the old one — recreate again with the OLD password so
      // every saved connection URL keeps working, then report the
      // persistence failure that caused this in the first place.
      try {
        await runPythonCommand({
          command: "recreate_instance",
          containerName: record.containerName,
          image: record.imageTag,
          password: oldPassword,
          memoryLimitMb: record.memoryLimitMb,
          evictionPolicy: record.evictionPolicy,
          persistence: record.persistence,
        });
      } catch (restoreErr) {
        console.error(
          `[RedisInstanceService] Password rotation for '${record.name}' failed to persist and the old password could not be restored; the instance is running with the new (unsaved) password. Rotate again to repair.`,
          restoreErr,
        );
        throw new RedisInstanceError(
          `Password rotation failed to save, and the old password could not be restored. The instance is running with the new password, which the panel does not know — rotate the password again to repair it.`,
          "REDIS_PASSWORD_STATE_DIVERGED",
          502,
        );
      }
      throw err;
    }

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

  /**
   * Tears down every instance owned by `userId` (container, volume, config)
   * and drops its row. Called before the owner is deleted: the schema cascades
   * the instance rows away with the user, which would leave running Docker
   * resources with no record left to manage them. Instances that tear down
   * successfully are removed one by one; if any fail, the surviving rows keep
   * the resources manageable and this throws so the caller keeps the user and
   * the delete can be retried.
   */
  async teardownAllForUser(userId: string): Promise<void> {
    const instances = await this.prisma.redisInstance.findMany({ where: { userId } });
    const failed: string[] = [];

    for (const instance of instances) {
      try {
        await runPythonCommand({
          command: "delete_instance",
          containerName: instance.containerName,
        });
        await this.prisma.redisInstance.delete({ where: { id: instance.id } });
      } catch (err) {
        console.error(
          `[RedisInstanceService] Failed to tear down instance '${instance.name}' (container '${instance.containerName}') of user '${userId}':`,
          err,
        );
        failed.push(instance.name);
      }
    }

    if (failed.length > 0) {
      throw new RedisInstanceError(
        `Failed to tear down Redis instances: ${failed.join(", ")}. The user was not deleted — fix the cause and retry.`,
        "REDIS_TEARDOWN_FAILED",
        502,
      );
    }
  }
}
