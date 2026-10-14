import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SftpError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "SftpError";
  }
}

// ---------------------------------------------------------------------------
// Locate sftp_manager.py
// ---------------------------------------------------------------------------

function getSftpManagerPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/sftp_manager.py"),
    resolve(currentDir, "../../../../system/python/sftp_manager.py"),
    resolve(process.cwd(), "../../system/python/sftp_manager.py"),
    resolve(process.cwd(), "system/python/sftp_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/sftp_manager.py");
}

function runSftpCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getSftpManagerPath();
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

    child.on("close", (exitCode) => {
      const raw = stdout.trim();
      if (!raw) {
        rejectP(
          new SftpError(
            `sftp_manager.py produced no output (stderr: ${stderr.trim()})`,
            "SFTP_NO_OUTPUT",
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
          new SftpError(
            `sftp_manager.py returned invalid JSON: ${raw}`,
            "SFTP_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed["error"] || exitCode !== 0) {
        rejectP(
          new SftpError(
            (parsed["error"] as string) || "SFTP system script failed",
            (parsed["code"] as string) || "SFTP_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolveP(parsed as T);
    });

    child.on("error", (err) => {
      rejectP(
        new SftpError(
          `Failed to spawn sftp_manager.py: ${err.message}`,
          "SFTP_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

import { encrypt, decrypt } from "../../utils/encryption.js";
import { getPythonBin } from "../../utils/pythonBin.js";

function decryptPasswordWithFallback(stored: string): { password: string | null; needsUpgrade: boolean } {
  // 1. Try modern SHA-256 derived key
  try {
    const plain = decrypt(stored);
    return { password: plain, needsUpgrade: false };
  } catch {
    // 2. Try legacy raw slice(0, 32) key
    try {
      const rawKey = Buffer.from(env.ENCRYPTION_KEY ?? env.SESSION_SECRET.slice(0, 32), "utf-8").slice(0, 32);
      const key = Buffer.alloc(32);
      rawKey.copy(key);
      const [ivHex, tagHex, encHex] = stored.split(":");
      if (!ivHex || !tagHex || !encHex) return { password: null, needsUpgrade: false };
      const iv = Buffer.from(ivHex, "hex");
      const tag = Buffer.from(tagHex, "hex");
      const enc = Buffer.from(encHex, "hex");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = decipher.update(enc).toString("utf-8") + decipher.final("utf-8");
      return { password: plain, needsUpgrade: true };
    } catch {
      return { password: null, needsUpgrade: false };
    }
  }
}

function generatePassword(length = 20): string {
  // URL-safe characters, avoids shell-special chars
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  return Array.from(crypto.randomBytes(length))
    .map((b) => chars[b % chars.length])
    .join("");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SftpService {
  constructor(private prisma: PrismaClient) {}

  async syncProjects(userId: string): Promise<void> {
    const record = await this.prisma.sftpUser.findUnique({
      where: { userId },
    });
    if (!record) return;

    const chrootDir = resolve(env.PROJECTS_DIR, userId);
    const projects = await this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true },
    });
    const projectList = projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: resolve(env.PROJECTS_DIR, p.id),
    }));

    try {
      await runSftpCommand({
        command: "sftp-sync-projects",
        linuxUsername: record.linuxUsername,
        chrootDir,
        projects: projectList,
      });
    } catch {
      // Non-fatal sync
    }
  }

  private resolveHost(reqHost?: string): string {
    if (env.SFTP_HOST && env.SFTP_HOST !== "0.0.0.0" && env.SFTP_HOST !== "your-server-ip") {
      return env.SFTP_HOST;
    }
    if (reqHost && reqHost !== "0.0.0.0") {
      return reqHost.split(":")[0] || "localhost";
    }
    return "localhost";
  }

  async provision(userId: string, reqHost?: string): Promise<{
    linuxUsername: string;
    password: string;
    host: string;
    port: number;
  }> {
    const existing = await this.prisma.sftpUser.findUnique({
      where: { userId },
    });

    if (existing) {
      // Re-use existing account — sync projects and return credentials
      await this.syncProjects(userId);
      let password = "hidden";
      if (existing.encryptedPassword) {
        const { password: decrypted, needsUpgrade } = decryptPasswordWithFallback(existing.encryptedPassword);
        if (decrypted) {
          password = decrypted;
          if (needsUpgrade) {
            await this.prisma.sftpUser.update({
              where: { userId },
              data: { encryptedPassword: encrypt(decrypted) },
            });
          }
        } else {
          // If decryption completely fails (e.g. key changed), rotate to a fresh password
          const fresh = generatePassword();
          await runSftpCommand({
            command: "sftp-rotate-password",
            linuxUsername: existing.linuxUsername,
            password: fresh,
          });
          await this.prisma.sftpUser.update({
            where: { userId },
            data: { encryptedPassword: encrypt(fresh) },
          });
          password = fresh;
        }
      }
      return {
        linuxUsername: existing.linuxUsername,
        password,
        host: this.resolveHost(reqHost),
        port: env.SFTP_PORT,
      };
    }

    // New account
    const password = generatePassword();
    const chrootDir = resolve(env.PROJECTS_DIR, userId);
    const projects = await this.prisma.project.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, name: true },
    });
    const projectList = projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: resolve(env.PROJECTS_DIR, p.id),
    }));

    const result = await runSftpCommand<{ linuxUsername: string }>({
      command: "sftp-provision",
      userId,
      password,
      chrootDir,
      projects: projectList,
    });

    await this.prisma.sftpUser.create({
      data: {
        userId,
        linuxUsername: result.linuxUsername,
        encryptedPassword: encrypt(password),
        isEnabled: true,
      },
    });

    return {
      linuxUsername: result.linuxUsername,
      password,
      host: this.resolveHost(reqHost),
      port: env.SFTP_PORT,
    };
  }

  async getCredentials(userId: string, reqHost?: string): Promise<{
    linuxUsername: string;
    password: string | null;
    host: string;
    port: number;
    sshPublicKeys: string[];
    isEnabled: boolean;
  } | null> {
    const record = await this.prisma.sftpUser.findUnique({
      where: { userId },
    });

    if (!record) return null;

    // Ensure projects are synced into chroot
    await this.syncProjects(userId);

    let password: string | null = null;
    if (record.encryptedPassword) {
      const { password: decrypted, needsUpgrade } = decryptPasswordWithFallback(record.encryptedPassword);
      password = decrypted;
      if (decrypted && needsUpgrade) {
        await this.prisma.sftpUser.update({
          where: { userId },
          data: { encryptedPassword: encrypt(decrypted) },
        });
      }
    }

    return {
      linuxUsername: record.linuxUsername,
      password,
      host: this.resolveHost(reqHost),
      port: env.SFTP_PORT,
      sshPublicKeys: record.sshPublicKeys,
      isEnabled: record.isEnabled,
    };
  }

  async rotatePassword(userId: string): Promise<{ password: string }> {
    const record = await this.findSftpUser(userId);
    const password = generatePassword();

    await runSftpCommand({
      command: "sftp-rotate-password",
      linuxUsername: record.linuxUsername,
      password,
    });

    await this.prisma.sftpUser.update({
      where: { userId },
      data: { encryptedPassword: encrypt(password) },
    });

    return { password };
  }

  async addSshKey(userId: string, publicKey: string): Promise<void> {
    const record = await this.findSftpUser(userId);
    const chrootDir = resolve(env.PROJECTS_DIR, userId);

    await runSftpCommand({
      command: "sftp-add-ssh-key",
      linuxUsername: record.linuxUsername,
      publicKey,
      chrootDir,
    });

    await this.prisma.sftpUser.update({
      where: { userId },
      data: { sshPublicKeys: { push: publicKey } },
    });
  }

  async disable(userId: string): Promise<void> {
    const record = await this.findSftpUser(userId);

    await runSftpCommand({
      command: "sftp-disable",
      linuxUsername: record.linuxUsername,
    });

    await this.prisma.sftpUser.update({
      where: { userId },
      data: { isEnabled: false },
    });
  }

  async enable(userId: string): Promise<void> {
    const record = await this.findSftpUser(userId);

    await runSftpCommand({
      command: "sftp-enable",
      linuxUsername: record.linuxUsername,
    });

    await this.prisma.sftpUser.update({
      where: { userId },
      data: { isEnabled: true },
    });

    await this.syncProjects(userId);
  }

  private async findSftpUser(userId: string) {
    const record = await this.prisma.sftpUser.findUnique({
      where: { userId },
    });

    if (!record) {
      throw new SftpError(
        "SFTP account not provisioned yet. Call provision first.",
        "SFTP_NOT_PROVISIONED",
        404,
      );
    }

    return record;
  }
}
