import { notifyAdmins } from "../system-email/notifier.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import type { BackupManifest, BackupItemType } from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { DeployService, runDockerStopByProject } from "../deploy/service.js";
import { DnsService } from "../domains/dns-service.js";
import type { AuditLogService } from "../audit-log/service.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BackupError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate backup_manager.py (mirrors monitoring/service.ts)
// ---------------------------------------------------------------------------

function getBackupScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/backup_manager.py"),
    resolve(currentDir, "../../../../system/python/backup_manager.py"),
    resolve(process.cwd(), "../../system/python/backup_manager.py"),
    resolve(process.cwd(), "system/python/backup_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/backup_manager.py");
}

// ---------------------------------------------------------------------------
// Startup health check (F5.14) — verifies the Python interpreter and
// backup_manager.py are both resolvable and runnable, so a misconfiguration
// is caught loudly at boot instead of silently at the next scheduled backup.
// ---------------------------------------------------------------------------

export function checkBackupScriptHealth(): Promise<{ ok: true } | { ok: false; error: string }> {
  const scriptPath = getBackupScriptPath();
  const pythonBin = env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

  if (!existsSync(scriptPath)) {
    return Promise.resolve({
      ok: false,
      error: `backup_manager.py not found at resolved path "${scriptPath}"`,
    });
  }

  return new Promise((resolvePromise) => {
    const child = spawn(pythonBin, ["--version"], { stdio: "ignore" });

    child.on("error", (err) => {
      resolvePromise({
        ok: false,
        error: `Python interpreter "${pythonBin}" is not runnable: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ ok: true });
      } else {
        resolvePromise({
          ok: false,
          error: `Python interpreter "${pythonBin}" exited with code ${code} when checking --version`,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helper — run a backup_manager.py command, forwarding "log" progress lines
// ---------------------------------------------------------------------------

function runBackupCommand<T>(
  payload: Record<string, unknown>,
  logger: FastifyBaseLogger,
  onLog?: (message: string) => void,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = getBackupScriptPath();
    const body = JSON.stringify(payload);

    const pythonBin = env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

    const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let result: unknown = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newlineIndex: number;
      // Process complete lines as they arrive so progress logs surface live.
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

        if (parsed && typeof parsed === "object" && "log" in parsed) {
          onLog?.((parsed as { log: string }).log);
        } else {
          result = parsed;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ err }, "backup_manager.py spawn error");
      reject(new BackupError(`Failed to start backup script: ${err.message}`, "SPAWN_ERROR", 500));
    });

    child.on("close", (code) => {
      // Flush any trailing line without a newline
      const trailing = stdout.trim();
      if (trailing) {
        try {
          const parsed = JSON.parse(trailing);
          if (parsed && typeof parsed === "object" && "log" in parsed) {
            onLog?.((parsed as { log: string }).log);
          } else {
            result = parsed;
          }
        } catch {
          // ignore trailing partial output
        }
      }

      if (stderr) {
        logger.debug({ stderr }, "backup_manager.py stderr output");
      }

      // Surface captured stderr in the rejected error so failures are
      // diagnosable from the dashboard, not just API debug logs (F5.14) —
      // a process that dies before printing any JSON (e.g. a misresolved
      // PYTHON_BIN or script path) shows nothing else.
      const stderrDetail = stderr.trim().slice(0, 2000);

      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof (result as Record<string, unknown>).error === "string"
      ) {
        const err = result as { error: string; code?: string };
        reject(new BackupError(err.error, err.code ?? "BACKUP_SCRIPT_ERROR", 500));
        return;
      }

      if (result === null) {
        const message = stderrDetail
          ? `Backup script exited with code ${code}: ${stderrDetail}`
          : `Backup script exited with code ${code} and no output`;
        reject(new BackupError(message, "EMPTY_OUTPUT", 500));
        return;
      }

      if (code !== 0) {
        const message = stderrDetail
          ? `Backup script exited with code ${code}: ${stderrDetail}`
          : `Backup script exited with code ${code}`;
        reject(new BackupError(message, "SCRIPT_ERROR", 500));
        return;
      }

      resolvePromise(result as T);
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Retention — keep the N most recent daily snapshots, plus up to M older
// ones spaced roughly a week apart (simple grandfather-father-son rotation)
// ---------------------------------------------------------------------------

function selectSnapshotsToKeep<T extends { id: string; createdAt: Date }>(
  completed: T[],
  retentionDaily: number,
  retentionWeekly: number,
): Set<string> {
  const sorted = [...completed].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>();

  const daily = sorted.slice(0, retentionDaily);
  for (const s of daily) keep.add(s.id);

  const older = sorted.slice(retentionDaily);
  let lastKeptAt = daily.length > 0 ? daily[daily.length - 1]!.createdAt : new Date();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  let weeklyKept = 0;

  for (const s of older) {
    if (weeklyKept >= retentionWeekly) break;
    if (lastKeptAt.getTime() - s.createdAt.getTime() >= WEEK_MS) {
      keep.add(s.id);
      lastKeptAt = s.createdAt;
      weeklyKept += 1;
    }
  }

  return keep;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BackupService {
  private deployService: DeployService;
  private dnsService: DnsService;

  constructor(
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
    private auditLog: AuditLogService,
  ) {
    this.deployService = new DeployService(prisma);
    this.dnsService = new DnsService(prisma);
  }

  async list() {
    return this.prisma.backupSnapshot.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const snapshot = await this.prisma.backupSnapshot.findUnique({ where: { id } });
    if (!snapshot) {
      throw new BackupError("Backup snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
    }
    return snapshot;
  }

  // `actorId` is omitted when called from the scheduled retention-cleanup
  // path (system-initiated, not a user action) — no audit entry is written
  // in that case, only for an admin-triggered delete via the API.
  async delete(id: string, actorId?: string) {
    const snapshot = await this.get(id);
    if (snapshot.archivePath) {
      await runBackupCommand({ command: "delete_archive", archivePath: snapshot.archivePath }, this.logger).catch(
        (err) => {
          this.logger.warn({ err, id }, "Failed to delete backup archive file");
        },
      );
    }
    await this.prisma.backupSnapshot.delete({ where: { id } });

    if (actorId) {
      await this.auditLog.log(actorId, "backup.deleted", { type: "BackupSnapshot", id }, {
        before: { trigger: snapshot.trigger, createdAt: snapshot.createdAt.toISOString() },
      });
    }
  }

  async getSettings() {
    const existing = await this.prisma.backupSettings.findUnique({ where: { id: "default" } });
    if (existing) return existing;

    return this.prisma.backupSettings.create({
      data: {
        id: "default",
        scheduleCron: env.BACKUP_SCHEDULE_CRON,
        retentionDaily: env.BACKUP_RETENTION_DAILY,
        retentionWeekly: env.BACKUP_RETENTION_WEEKLY,
      },
    });
  }

  async updateSettings(data: { scheduleCron: string; retentionDaily: number; retentionWeekly: number }) {
    return this.prisma.backupSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
  }

  // -------------------------------------------------------------------------
  // create_snapshot
  // -------------------------------------------------------------------------

  async runBackupJob(snapshotId: string, io: SocketIOServer): Promise<void> {
    await this.prisma.backupSnapshot.update({
      where: { id: snapshotId },
      data: { status: "RUNNING" },
    });

    const emitProgress = (message: string) => {
      io.to("backups").emit("backup:progress", { snapshotId, message });
    };

    try {
      const [projects, databases, domains] = await Promise.all([
        this.prisma.project.findMany({ where: { deletedAt: null } }),
        this.prisma.database.findMany(),
        this.prisma.domain.findMany({
          include: { dnsRecords: true, mailboxes: { select: { id: true } } },
        }),
      ]);

      const mailDomains = domains.filter((d) => d.mailboxes.length > 0);
      const dnsDomains = domains.filter((d) => d.dnsRecords.length > 0);

      const manifest = await runBackupCommand<{
        success: boolean;
        archivePath: string;
        sizeBytes: number;
        manifest: BackupManifest;
      }>(
        {
          command: "create_snapshot",
          snapshotId,
          backupsDir: resolve(env.BACKUPS_DIR),
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            path: resolve(env.PROJECTS_DIR, p.id),
          })),
          databases: databases.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            container: d.type === "POSTGRESQL" ? env.POSTGRES_CONTAINER_NAME : env.MYSQL_CONTAINER_NAME,
            dbUser: d.type === "POSTGRESQL" ? d.dbUser : env.MYSQL_ROOT_USER,
            dbPassword: d.type === "POSTGRESQL" ? d.dbPassword : env.MYSQL_ROOT_PASSWORD,
          })),
          mail: mailDomains.map((d) => ({ domainId: d.id, hostname: d.hostname })),
          dns: dnsDomains.map((d) => ({
            domainId: d.id,
            hostname: d.hostname,
            records: d.dnsRecords.map((r) => ({
              type: r.type,
              name: r.name,
              value: r.value,
              ttl: r.ttl,
              priority: r.priority,
              weight: r.weight,
              port: r.port,
            })),
          })),
        },
        this.logger,
        emitProgress,
      );

      await this.prisma.backupSnapshot.update({
        where: { id: snapshotId },
        data: {
          status: "COMPLETED",
          archivePath: manifest.archivePath,
          sizeBytes: BigInt(manifest.sizeBytes),
          manifest: manifest.manifest,
          completedAt: new Date(),
        },
      });

      io.to("backups").emit("backup:completed", { snapshotId, status: "COMPLETED" });

      await this.applyRetention();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown backup error";
      this.logger.error({ err, snapshotId }, "Backup job failed");
      await this.prisma.backupSnapshot.update({
        where: { id: snapshotId },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      io.to("backups").emit("backup:completed", { snapshotId, status: "FAILED", error: message });
      notifyAdmins("backup_failed", { error: message.slice(0, 500), snapshotId });
    }
  }

  async applyRetention(): Promise<void> {
    const settings = await this.getSettings();
    const completed = await this.prisma.backupSnapshot.findMany({
      where: { status: "COMPLETED" },
      select: { id: true, createdAt: true },
    });

    const keep = selectSnapshotsToKeep(completed, settings.retentionDaily, settings.retentionWeekly);
    const toDelete = completed.filter((s) => !keep.has(s.id));

    for (const s of toDelete) {
      try {
        await this.delete(s.id);
      } catch (err) {
        this.logger.warn({ err, id: s.id }, "Failed to delete snapshot during retention cleanup");
      }
    }
  }

  // -------------------------------------------------------------------------
  // restore_item
  // -------------------------------------------------------------------------

  async restoreItem(
    actorId: string,
    snapshotId: string,
    itemType: BackupItemType,
    itemId: string,
    io: SocketIOServer,
  ): Promise<void> {
    const snapshot = await this.get(snapshotId);
    if (!snapshot.archivePath || snapshot.status !== "COMPLETED") {
      throw new BackupError("Snapshot is not restorable (not completed)", "SNAPSHOT_NOT_RESTORABLE", 400);
    }

    const manifest = snapshot.manifest as BackupManifest | null;
    if (!manifest) {
      throw new BackupError("Snapshot has no manifest", "MANIFEST_MISSING", 400);
    }

    const emitProgress = (message: string) => {
      io.to("backups").emit("restore:progress", { snapshotId, itemType, itemId, message });
    };

    try {
      if (itemType === "dns") {
        await this.restoreDns(manifest, itemId);
      } else if (itemType === "project") {
        await this.restoreProject(snapshot.archivePath, manifest, itemId, emitProgress);
      } else if (itemType === "database") {
        await this.restoreDatabase(snapshot.archivePath, manifest, itemId, emitProgress);
      } else if (itemType === "mail") {
        await this.restoreMail(snapshot.archivePath, manifest, itemId, emitProgress);
      }

      io.to("backups").emit("restore:completed", { snapshotId, itemType, itemId, status: "COMPLETED" });

      await this.auditLog.log(actorId, "backup.restored", { type: "BackupSnapshot", id: snapshotId }, {
        after: { itemType, itemId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown restore error";
      io.to("backups").emit("restore:completed", { snapshotId, itemType, itemId, status: "FAILED", error: message });
      throw err;
    }
  }

  private async restoreDns(manifest: BackupManifest, domainId: string): Promise<void> {
    const entry = manifest.dns.find((d) => d.domainId === domainId);
    if (!entry) {
      throw new BackupError("DNS domain not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT", 404);
    }

    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) {
      throw new BackupError("Domain no longer exists", "DOMAIN_NOT_FOUND", 404);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.dnsRecord.deleteMany({ where: { domainId } });
      for (const r of entry.records) {
        await tx.dnsRecord.create({
          data: {
            domainId,
            type: r.type,
            name: r.name,
            value: r.value,
            ttl: r.ttl,
            priority: r.priority,
            weight: r.weight,
            port: r.port,
          },
        });
      }
    });

    await this.dnsService.syncZoneFile(domain.hostname, domain.id);
  }

  private async restoreProject(
    archivePath: string,
    manifest: BackupManifest,
    projectId: string,
    onLog: (message: string) => void,
  ): Promise<void> {
    if (!manifest.projects.some((p) => p.id === projectId)) {
      throw new BackupError("Project not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT", 404);
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new BackupError("Project no longer exists", "PROJECT_NOT_FOUND", 404);
    }

    // Revive a soft-deleted project *before* touching its container or
    // files — otherwise DeployService.containerAction (and the project
    // itself) stays invisible to the rest of the app even after its files
    // are restored, since project lookups everywhere filter out deletedAt.
    if (project.deletedAt) {
      await this.prisma.project.update({
        where: { id: project.id },
        data: { deletedAt: null, status: "STOPPED" },
      });
    }

    // A soft-deleted project has had its workspace removed (its containerId is
    // kept), so the compose file containerAction needs is gone. That must not
    // make the project unrecoverable, but a missing workspace does not prove
    // its containers are gone either (teardown tolerates a failed removal), so
    // in that case they are stopped and verified by project identity instead.
    const workspaceExists = existsSync(resolve(env.PROJECTS_DIR, projectId));

    if (project.containerId) {
      try {
        if (workspaceExists) {
          await this.deployService.containerAction(project.userId, project.id, "stop");
        } else {
          await runDockerStopByProject(project.id);
        }
      } catch (err) {
        this.logger.error({ err, projectId }, "Container stop failed before project restore");
        throw new BackupError(
          "Project restore aborted: containers could not be confirmed stopped. Resolve the container error and retry.",
          "RESTORE_STOP_FAILED",
          500,
        );
      }
    }

    await runBackupCommand(
      {
        command: "restore_item",
        itemType: "project",
        itemId: projectId,
        archivePath,
        targetPath: resolve(env.PROJECTS_DIR, projectId),
      },
      this.logger,
      onLog,
    );

    if (project.containerId) {
      await this.deployService.containerAction(project.userId, project.id, "start").catch(() => undefined);
    }
  }

  private async restoreDatabase(
    archivePath: string,
    manifest: BackupManifest,
    databaseId: string,
    onLog: (message: string) => void,
  ): Promise<void> {
    if (!manifest.databases.some((d) => d.id === databaseId)) {
      throw new BackupError("Database not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT", 404);
    }

    const database = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!database) {
      throw new BackupError("Database no longer exists", "DATABASE_NOT_FOUND", 404);
    }

    await runBackupCommand(
      {
        command: "restore_item",
        itemType: "database",
        itemId: databaseId,
        archivePath,
        dbName: database.name,
        dbType: database.type,
        container: database.type === "POSTGRESQL" ? env.POSTGRES_CONTAINER_NAME : env.MYSQL_CONTAINER_NAME,
        dbUser: database.type === "POSTGRESQL" ? database.dbUser : env.MYSQL_ROOT_USER,
        dbPassword: database.type === "POSTGRESQL" ? database.dbPassword : env.MYSQL_ROOT_PASSWORD,
      },
      this.logger,
      onLog,
    );
  }

  private async restoreMail(
    archivePath: string,
    manifest: BackupManifest,
    domainId: string,
    onLog: (message: string) => void,
  ): Promise<void> {
    if (!manifest.mail.some((m) => m.domainId === domainId)) {
      throw new BackupError("Mail domain not found in this snapshot", "ITEM_NOT_IN_SNAPSHOT", 404);
    }

    const domain = await this.prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) {
      throw new BackupError("Domain no longer exists", "DOMAIN_NOT_FOUND", 404);
    }

    await runBackupCommand(
      {
        command: "restore_item",
        itemType: "mail",
        itemId: domainId,
        archivePath,
        hostname: domain.hostname,
      },
      this.logger,
      onLog,
    );
  }
}
