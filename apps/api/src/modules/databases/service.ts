import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient, DatabaseType } from "@prisma/client";
import { env } from "../../config/env.js";
import { encrypt, decrypt } from "../../utils/encryption.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import { EnvService } from "../env/service.js";
import type { AuditLogService } from "../audit-log/service.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import type {
  CreateDatabaseInput,
  DatabaseListQuery,
  DatabaseDetail,
  DatabaseConnectionTestResult,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Error Class
// ---------------------------------------------------------------------------

export class DatabaseError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

// ---------------------------------------------------------------------------
// Locate database_manager.py
// ---------------------------------------------------------------------------

function getDatabaseManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/database_manager.py"),
    resolve(currentDir, "../../../../system/python/database_manager.py"),
    resolve(process.cwd(), "../../system/python/database_manager.py"),
    resolve(process.cwd(), "system/python/database_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return (
    candidates[0] ?? resolve(process.cwd(), "system/python/database_manager.py")
  );
}

function runPythonCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getDatabaseManagerScriptPath();
    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

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
        rejectP(
          new DatabaseError(
            `database_manager.py produced no output (stderr: ${stderr.trim()})`,
            "DB_SYSTEM_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectP(
          new DatabaseError(
            `database_manager.py returned invalid JSON: ${raw}`,
            "DB_SYSTEM_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed.error || code !== 0) {
        rejectP(
          new DatabaseError(
            (parsed.error as string) || "System database script failed",
            (parsed.code as string) || "DB_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolveP(parsed as T);
    });

    child.on("error", (err) => {
      rejectP(
        new DatabaseError(
          `Failed to spawn system database manager: ${err.message}`,
          "DB_SPAWN_ERROR",
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

function generateSecurePassword(length = 24): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

function generateDbUsername(dbName: string): string {
  const cleanName = dbName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  const rand = randomBytes(4).toString("hex");
  return `u_${cleanName}_${rand}`;
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------

export class DatabaseService {
  private envService: EnvService;

  // Optional: WordpressService constructs a DatabaseService of its own to
  // reuse provisioning internals — audit logging is only required on the
  // instance routes.ts hands to create()/delete().
  constructor(
    private prisma: PrismaClient,
    private auditLog?: AuditLogService,
  ) {
    this.envService = new EnvService(prisma);
  }

  /**
   * Provision a new isolated database and user on the selected engine.
   */
  async create(
    userId: string,
    input: CreateDatabaseInput,
  ): Promise<DatabaseDetail> {
    await assertUnderQuota(
      this.prisma,
      userId,
      "database",
      (message, code, statusCode) =>
        new DatabaseError(message, code, statusCode),
    );

    // 1. Check for name collision under this user
    const existing = await this.prisma.database.findUnique({
      where: {
        userId_name: {
          userId,
          name: input.name,
        },
      },
    });

    if (existing) {
      throw new DatabaseError(
        `A database named '${input.name}' already exists for your account`,
        "DATABASE_NAME_CONFLICT",
        409,
      );
    }

    // 2. If attached to a project, verify project ownership
    if (input.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, userId: true, deletedAt: true },
      });
      if (!project || project.deletedAt !== null || project.userId !== userId) {
        throw new DatabaseError(
          "Attached project not found",
          "PROJECT_NOT_FOUND",
          404,
        );
      }
    }

    // 3. Generate credentials
    const dbUser = generateDbUsername(input.name);
    const plainPassword = generateSecurePassword(24);
    const encryptedPassword = encrypt(plainPassword);

    const isPostgres = input.type === "POSTGRESQL";
    const host = isPostgres ? env.POSTGRES_HOST : env.MYSQL_HOST;
    const port = isPostgres ? env.POSTGRES_PORT : env.MYSQL_PORT;
    const containerName = isPostgres
      ? env.POSTGRES_CONTAINER_NAME
      : env.MYSQL_CONTAINER_NAME;
    const rootUser = isPostgres ? env.POSTGRES_USER : env.MYSQL_ROOT_USER;
    const rootPassword = isPostgres
      ? env.POSTGRES_PASSWORD
      : env.MYSQL_ROOT_PASSWORD;

    // 4. Execute system provisioning via database_manager.py
    await runPythonCommand({
      command: "create_database",
      engine: input.type,
      containerName,
      dbName: input.name,
      dbUser,
      dbPassword: plainPassword,
      rootUser,
      rootPassword,
    });

    // 5. Store record in Prisma
    const dbRecord = await this.prisma.database.create({
      data: {
        name: input.name,
        type: input.type as DatabaseType,
        host,
        port,
        dbUser,
        dbPassword: encryptedPassword,
        userId,
        projectId: input.projectId ?? null,
      },
      include: {
        project: {
          select: { id: true, name: true },
        },
      },
    });
    void notifyQuotaThreshold(this.prisma, userId, "database");

    // 6. Optionally auto-inject connection env vars into project
    if (input.projectId && input.autoInjectEnv !== false) {
      const internalUri = this.buildConnectionString(
        input.type,
        dbUser,
        plainPassword,
        containerName,
        port,
        input.name,
      );

      const envVars = [
        { key: "DATABASE_URL", value: internalUri },
        { key: "DB_TYPE", value: input.type },
        { key: "DB_HOST", value: containerName },
        { key: "DB_PORT", value: String(port) },
        { key: "DB_NAME", value: input.name },
        { key: "DB_USER", value: dbUser },
        { key: "DB_PASSWORD", value: plainPassword },
      ];

      await this.envService.bulkUpsert(userId, input.projectId, envVars);
    }

    await this.auditLog?.log(
      userId,
      "database.created",
      { type: "Database", id: dbRecord.id },
      {
        after: { name: dbRecord.name, engine: dbRecord.type },
      },
    );

    return this.formatDatabaseDetail(dbRecord, plainPassword);
  }

  /**
   * List databases belonging to the user.
   */
  async list(userId: string, query: DatabaseListQuery) {
    const { projectId, type, search, page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;

    const where: {
      userId: string;
      projectId?: string;
      type?: DatabaseType;
      name?: { contains: string; mode: "insensitive" };
    } = { userId };

    if (projectId) where.projectId = projectId;
    if (type) where.type = type as DatabaseType;
    if (search) where.name = { contains: search, mode: "insensitive" };

    const [total, records] = await Promise.all([
      this.prisma.database.count({ where }),
      this.prisma.database.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          project: {
            select: { id: true, name: true },
          },
        },
      }),
    ]);

    const databases = records.map((rec) => {
      let plainPw: string | undefined;
      try {
        plainPw = decrypt(rec.dbPassword);
      } catch {
        plainPw = undefined;
      }
      return this.formatDatabaseDetail(rec, plainPw);
    });

    return {
      databases,
      adminer: this.getAdminerAvailability(),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single database detail by ID.
   */
  async getById(userId: string, id: string): Promise<DatabaseDetail> {
    const record = await this.prisma.database.findUnique({
      where: { id },
      include: {
        project: {
          select: { id: true, name: true },
        },
      },
    });

    if (!record || record.userId !== userId) {
      throw new DatabaseError("Database not found", "DATABASE_NOT_FOUND", 404);
    }

    let plainPw: string;
    try {
      plainPw = decrypt(record.dbPassword);
    } catch {
      throw new DatabaseError(
        "Failed to decrypt database password",
        "DECRYPTION_ERROR",
        500,
      );
    }

    return this.formatDatabaseDetail(record, plainPw);
  }

  /**
   * Test live connection to the database.
   */
  async testConnection(
    userId: string,
    id: string,
  ): Promise<DatabaseConnectionTestResult> {
    const record = await this.prisma.database.findUnique({
      where: { id },
    });

    if (!record || record.userId !== userId) {
      throw new DatabaseError("Database not found", "DATABASE_NOT_FOUND", 404);
    }

    let plainPw: string;
    try {
      plainPw = decrypt(record.dbPassword);
    } catch {
      throw new DatabaseError(
        "Failed to decrypt database password",
        "DECRYPTION_ERROR",
        500,
      );
    }

    const isPostgres = record.type === "POSTGRESQL";
    const containerName = isPostgres
      ? env.POSTGRES_CONTAINER_NAME
      : env.MYSQL_CONTAINER_NAME;

    return await runPythonCommand<DatabaseConnectionTestResult>({
      command: "test_connection",
      engine: record.type,
      containerName,
      dbName: record.name,
      dbUser: record.dbUser,
      dbPassword: plainPw,
    });
  }

  /**
   * Delete database and associated user.
   */
  async delete(
    userId: string,
    id: string,
  ): Promise<{ success: boolean; id: string }> {
    const record = await this.prisma.database.findUnique({
      where: { id },
    });

    if (!record || record.userId !== userId) {
      throw new DatabaseError("Database not found", "DATABASE_NOT_FOUND", 404);
    }

    const isPostgres = record.type === "POSTGRESQL";
    const containerName = isPostgres
      ? env.POSTGRES_CONTAINER_NAME
      : env.MYSQL_CONTAINER_NAME;
    const rootUser = isPostgres ? env.POSTGRES_USER : env.MYSQL_ROOT_USER;
    const rootPassword = isPostgres
      ? env.POSTGRES_PASSWORD
      : env.MYSQL_ROOT_PASSWORD;

    // Drop from container engine
    try {
      await runPythonCommand({
        command: "delete_database",
        engine: record.type,
        containerName,
        dbName: record.name,
        dbUser: record.dbUser,
        rootUser,
        rootPassword,
      });
    } catch (err) {
      // The drop statements are idempotent (DROP ... IF EXISTS), so an
      // already-dropped database is a success, not an error. Anything that
      // reaches here is a real failure (engine down, bad root credentials,
      // SQL error). Keep the record and report it: deleting the row anyway
      // would orphan a live database with data in it, and the audit trail
      // would claim a deletion that never happened.
      const reason = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Could not drop database "${record.name}": ${reason}. The record was kept — resolve the problem and try again.`,
        "DATABASE_DROP_FAILED",
        502,
      );
    }

    // Only reached once the engine confirmed the drop. Delete from Prisma
    await this.prisma.database.delete({
      where: { id },
    });

    await this.auditLog?.log(
      userId,
      "database.deleted",
      { type: "Database", id },
      {
        before: { name: record.name, engine: record.type },
      },
    );

    return { success: true, id };
  }

  // ---------------------------------------------------------------------------
  // Internal Formatters
  // ---------------------------------------------------------------------------

  private buildConnectionString(
    type: DatabaseType | string,
    user: string,
    pw: string,
    host: string,
    port: number,
    dbName: string,
  ): string {
    const encodedUser = encodeURIComponent(user);
    const encodedPw = encodeURIComponent(pw);
    if (type === "POSTGRESQL") {
      return `postgresql://${encodedUser}:${encodedPw}@${host}:${port}/${dbName}`;
    }
    return `mysql://${encodedUser}:${encodedPw}@${host}:${port}/${dbName}`;
  }

  private buildAdminerUrl(
    type: DatabaseType | string,
    containerHost: string,
    user: string,
    dbName: string,
  ): string | undefined {
    if (!env.ADMINER_URL) return undefined;

    const baseUrl = env.ADMINER_URL.replace(/\/$/, "");
    if (type === "POSTGRESQL") {
      return `${baseUrl}/?pgsql=${encodeURIComponent(containerHost)}&username=${encodeURIComponent(user)}&db=${encodeURIComponent(dbName)}`;
    }
    return `${baseUrl}/?server=${encodeURIComponent(containerHost)}&username=${encodeURIComponent(user)}&db=${encodeURIComponent(dbName)}`;
  }

  private getAdminerAvailability() {
    if (!env.ADMINER_URL) {
      return {
        enabled: false,
        disabledReason:
          "Adminer is disabled. An administrator must configure secure access.",
      };
    }

    return { enabled: true, url: env.ADMINER_URL };
  }

  private formatDatabaseDetail(
    rec: {
      id: string;
      name: string;
      type: DatabaseType;
      host: string;
      port: number;
      dbUser: string;
      userId: string;
      projectId: string | null;
      project?: { id: string; name: string } | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    },
    plainPassword?: string,
  ): DatabaseDetail {
    const isPostgres = rec.type === "POSTGRESQL";
    const internalHost = isPostgres
      ? env.POSTGRES_CONTAINER_NAME
      : env.MYSQL_CONTAINER_NAME;
    const effectivePw = plainPassword ?? "********";

    const connectionString = this.buildConnectionString(
      rec.type,
      rec.dbUser,
      effectivePw,
      rec.host,
      rec.port,
      rec.name,
    );

    const internalConnectionString = this.buildConnectionString(
      rec.type,
      rec.dbUser,
      effectivePw,
      internalHost,
      rec.port,
      rec.name,
    );

    const adminerUrl = this.buildAdminerUrl(
      rec.type,
      internalHost,
      rec.dbUser,
      rec.name,
    );

    return {
      id: rec.id,
      name: rec.name,
      type: rec.type,
      host: rec.host,
      port: rec.port,
      internalHost,
      dbUser: rec.dbUser,
      dbPassword: plainPassword,
      connectionString,
      internalConnectionString,
      adminerUrl,
      userId: rec.userId,
      projectId: rec.projectId,
      project: rec.project ?? null,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }
}
