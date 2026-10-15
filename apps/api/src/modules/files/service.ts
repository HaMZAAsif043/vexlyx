import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { getPythonBin } from "../../utils/pythonBin.js";
import {
  PYTHON_SCRIPT_TIMEOUT_MS,
  watchChildTimeout,
} from "../../utils/processWatchdog.js";
import type { AuditLogService } from "../audit-log/service.js";
import { safePath } from "./schema.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FileError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "FileError";
  }
}

// ---------------------------------------------------------------------------
// File node shape
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  mtime?: string;
  extension?: string;
  /** Octal permission bits, e.g. "644". */
  mode?: string;
  children?: FileNode[];
}

export interface ExtractResult {
  extracted: number;
  skipped: string[];
}

export interface CompressResult {
  files: number;
  skippedLinks: number;
}

// ---------------------------------------------------------------------------
// Max readable file size (2 MB)
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 2 * 1024 * 1024;

// Upper bound on entries touched by one recursive chmod.
const MAX_CHMOD_ENTRIES = 100_000;

const ARCHIVE_ERROR_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  PATH_TRAVERSAL: 403,
  SOURCE_NOT_FOUND: 404,
  CONFLICT: 409,
  ARCHIVE_TOO_LARGE: 413,
  UNSUPPORTED_FORMAT: 415,
  UNSAFE_ARCHIVE: 422,
  CORRUPT_ARCHIVE: 422,
  ARCHIVE_TIMEOUT: 504,
};

function getArchiveScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../../../../../system/python/archive_manager.py"),
    path.resolve(currentDir, "../../../../system/python/archive_manager.py"),
    path.resolve(process.cwd(), "../../system/python/archive_manager.py"),
    path.resolve(process.cwd(), "system/python/archive_manager.py"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    candidates[0] ??
    path.resolve(process.cwd(), "system/python/archive_manager.py")
  );
}

function archiveLimits() {
  return {
    maxBytes: env.FILE_ARCHIVE_MAX_BYTES,
    maxEntries: env.FILE_ARCHIVE_MAX_ENTRIES,
    maxRatio: env.FILE_ARCHIVE_MAX_RATIO,
  };
}

function runArchiveCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(getPythonBin(), ["-I", getArchiveScriptPath()], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    watchChildTimeout(child, PYTHON_SCRIPT_TIMEOUT_MS.archive, (ms) =>
      reject(
        new FileError(
          `Archive operation timed out after ${ms / 1000}s`,
          "ARCHIVE_TIMEOUT",
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
    child.on("error", (err) => {
      reject(new FileError(`Failed to start archive helper: ${err.message}`, "SPAWN_ERROR", 500));
    });
    child.on("close", () => {
      let parsed: unknown;
      try {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        parsed = JSON.parse(lastLine);
      } catch {
        reject(
          new FileError(
            `Archive helper returned no result${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
            "ARCHIVE_SCRIPT_ERROR",
            500,
          ),
        );
        return;
      }
      const result = parsed as { error?: string; code?: string };
      if (typeof result.error === "string") {
        const code = result.code ?? "ARCHIVE_ERROR";
        reject(new FileError(result.error, code, ARCHIVE_ERROR_STATUS[code] ?? 500));
        return;
      }
      resolve(parsed as T);
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FileService {
  constructor(
    private prisma: PrismaClient,
    private auditLog: AuditLogService,
  ) { }

  // ── Security: resolve + guard ──────────────────────────────────────────

  private async resolveAndGuard(
    userId: string,
    projectId: string,
    relPath: string,
    forWrite = false,
  ): Promise<string> {
    // Verify ownership
    await this.findOwnedProject(userId, projectId);

    const sanitized = safePath(relPath, forWrite);
    const projectRoot = path.resolve(env.PROJECTS_DIR, projectId);
    const target = path.resolve(projectRoot, sanitized);

    // After resolve: must still be inside project root
    if (!target.startsWith(projectRoot + path.sep) && target !== projectRoot) {
      throw new FileError("Path escapes project root", "PATH_TRAVERSAL", 403);
    }

    // Follow symlinks and verify the real path stays inside root
    try {
      const real = await fs.realpath(target);
      if (!real.startsWith(projectRoot + path.sep) && real !== projectRoot) {
        throw new FileError("Symlink escapes project root", "SYMLINK_ESCAPE", 403);
      }
    } catch (err) {
      // realpath throws ENOENT for non-existent paths (ok for create ops)
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    return target;
  }

  private projectRoot(projectId: string): string {
    return path.resolve(env.PROJECTS_DIR, projectId);
  }

  // ── List directory ─────────────────────────────────────────────────────

  async listDir(
    userId: string,
    projectId: string,
    relPath: string,
    depth = 1,
  ): Promise<FileNode[]> {
    const target = await this.resolveAndGuard(userId, projectId, relPath || "");
    return this.readDirRecursive(
      target,
      this.projectRoot(projectId),
      depth,
    );
  }

  private async readDirRecursive(
    absDir: string,
    rootDir: string,
    depth: number,
  ): Promise<FileNode[]> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      throw new FileError("Directory not found or not accessible", "DIR_NOT_FOUND", 404);
    }

    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
      const isDir = entry.isDirectory();

      const node: FileNode = {
        name: entry.name,
        path: rel,
        type: isDir ? "dir" : "file",
      };

      if (!entry.isSymbolicLink()) {
        try {
          const lst = await fs.lstat(abs);
          node.mode = (lst.mode & 0o777).toString(8).padStart(3, "0");
        } catch {
          // mode is informational only
        }
      }

      if (!isDir) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (ext) node.extension = ext;
        try {
          const stat = await fs.stat(abs);
          node.size = stat.size;
          node.mtime = stat.mtime.toISOString();
        } catch {
          // skip stat on error
        }
      }

      if (isDir && depth > 1) {
        node.children = await this.readDirRecursive(abs, rootDir, depth - 1);
      }

      nodes.push(node);
    }

    // Dirs first, then files, alphabetical within each group
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  // ── Read file ──────────────────────────────────────────────────────────

  async readFile(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<string> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);

    const stat = await fs.stat(target).catch(() => {
      throw new FileError("File not found", "FILE_NOT_FOUND", 404);
    });

    if (stat.isDirectory()) {
      throw new FileError("Path is a directory, not a file", "IS_DIRECTORY", 400);
    }

    if (stat.size > MAX_READ_BYTES) {
      throw new FileError(
        `File is too large to edit in browser (max ${MAX_READ_BYTES / 1024 / 1024} MB)`,
        "FILE_TOO_LARGE",
        413,
      );
    }

    const content = await fs.readFile(target, "utf-8");
    return content;
  }

  // ── Create file (never overwrites) ──────────────────────────────────────

  async createFile(
    userId: string,
    projectId: string,
    relPath: string,
    content = "",
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "FILE_ALREADY_EXISTS",
        409,
      );
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic write via temp file
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, target);
  }

  // ── Write file ─────────────────────────────────────────────────────────

  async writeFile(
    userId: string,
    projectId: string,
    relPath: string,
    content: string,
    createOnly = false,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const stat = await fs.lstat(target).catch(() => null);
    if (stat) {
      if (stat.isDirectory()) {
        throw new FileError(
          `Cannot overwrite directory "${path.posix.basename(relPath)}" with a file`,
          "IS_DIRECTORY",
          400,
        );
      }
      if (createOnly) {
        throw new FileError(
          `A file or folder named "${path.posix.basename(relPath)}" already exists`,
          "FILE_ALREADY_EXISTS",
          409,
        );
      }
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic write via temp file
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, target);
  }

  // ── Delete ─────────────────────────────────────────────────────────────

  async deleteNode(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);
    const root = this.projectRoot(projectId);

    // Never allow deleting the project root itself
    if (target === root) {
      throw new FileError("Cannot delete project root", "DELETE_ROOT", 400);
    }

    await fs.rm(target, { recursive: true, force: true });
  }

  // ── Rename ─────────────────────────────────────────────────────────────

  async rename(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel, true);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    await fs.stat(from).catch(() => {
      throw new FileError("Source file not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.lstat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  // ── Mkdir ──────────────────────────────────────────────────────────────

  async mkdir(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);
    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "DIRECTORY_ALREADY_EXISTS",
        409,
      );
    }
    await fs.mkdir(target, { recursive: true });
  }

  // ── Copy ───────────────────────────────────────────────────────────────

  async copy(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    const stat = await fs.stat(from).catch(() => {
      throw new FileError("Source not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.stat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `Destination "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });

    if (stat.isDirectory()) {
      await fs.cp(from, to, { recursive: true });
    } else {
      await fs.copyFile(from, to);
    }
  }

  // ── Move ───────────────────────────────────────────────────────────────

  async move(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel, true);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    await fs.stat(from).catch(() => {
      throw new FileError("Source not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.stat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `Destination "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EXDEV") {
        await this.copy(userId, projectId, fromRel, toRel);
        await this.deleteNode(userId, projectId, fromRel);
      } else {
        throw err;
      }
    }
  }

  // ── Permissions (chmod) ────────────────────────────────────────────────

  async chmod(
    userId: string,
    projectId: string,
    relPath: string,
    mode: string,
    recursive = false,
    fileMode?: string,
  ): Promise<{ changed: number }> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);
    const root = this.projectRoot(projectId);

    if (target === root) {
      throw new FileError("Cannot change permissions of the project root", "CHMOD_ROOT", 400);
    }

    const stat = await fs.lstat(target).catch(() => {
      throw new FileError("File or folder not found", "SOURCE_NOT_FOUND", 404);
    });
    if (stat.isSymbolicLink()) {
      throw new FileError("Permissions of a symbolic link cannot be changed", "IS_SYMLINK", 400);
    }
    if (recursive && !stat.isDirectory()) {
      throw new FileError("Recursive permissions apply to folders only", "NOT_A_DIRECTORY", 400);
    }

    const dirBits = parseInt(mode, 8);
    const fileBits = parseInt(fileMode ?? mode, 8);
    const touchesDirs = stat.isDirectory();
    const touchesFiles = !stat.isDirectory() || recursive;

    // Without owner rwx on a folder the API (and the app) can no longer list
    // or repair it; without owner read a file can't be edited back.
    if (touchesDirs && (dirBits & 0o700) !== 0o700) {
      throw new FileError(
        "Folders must keep read, write and execute for the owner (at least 700)",
        "INVALID_MODE",
        400,
      );
    }
    if (touchesFiles && (fileBits & 0o400) === 0) {
      throw new FileError("Files must stay readable by the owner", "INVALID_MODE", 400);
    }

    let changed = 0;
    const apply = async (abs: string, bits: number) => {
      await fs.chmod(abs, bits);
      changed += 1;
      if (changed > MAX_CHMOD_ENTRIES) {
        throw new FileError("Too many items for one recursive change", "TOO_MANY_ENTRIES", 413);
      }
    };

    if (!recursive) {
      await apply(target, stat.isDirectory() ? dirBits : fileBits);
    } else {
      // Symlinks are skipped: chmod follows them and would reach outside the project.
      const stack = [target];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        await apply(dir, dirBits);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) stack.push(abs);
          else if (entry.isFile()) await apply(abs, fileBits);
        }
      }
    }

    await this.auditLog.log(userId, "file.permissions_changed", { type: "Project", id: projectId }, {
      after: { path: relPath, mode, recursive, ...(recursive && { fileMode: fileMode ?? mode }), changed },
    });

    return { changed };
  }

  // ── Extract archive ────────────────────────────────────────────────────

  async extract(
    userId: string,
    projectId: string,
    archiveRel: string,
    destinationRel?: string,
    overwrite = false,
  ): Promise<ExtractResult> {
    const archive = await this.resolveAndGuard(userId, projectId, archiveRel);
    const root = this.projectRoot(projectId);
    const destRel = destinationRel ?? (path.posix.dirname(safePath(archiveRel)) || ".");
    const dest = await this.resolveAndGuard(userId, projectId, destRel, true);

    const stat = await fs.stat(archive).catch(() => {
      throw new FileError("Archive not found", "SOURCE_NOT_FOUND", 404);
    });
    if (!stat.isFile()) {
      throw new FileError("Selected item is not a file", "NOT_A_FILE", 400);
    }

    const result = await runArchiveCommand<ExtractResult>({
      command: "extract",
      root,
      archive,
      dest,
      overwrite,
      limits: archiveLimits(),
    });

    await this.auditLog.log(userId, "file.archive_extracted", { type: "Project", id: projectId }, {
      after: { archive: archiveRel, destination: destRel, extracted: result.extracted, skipped: result.skipped.length },
    });

    return { extracted: result.extracted, skipped: result.skipped };
  }

  // ── Compress selection ─────────────────────────────────────────────────

  async compress(
    userId: string,
    projectId: string,
    sourcesRel: string[],
    destinationRel: string,
  ): Promise<CompressResult> {
    const root = this.projectRoot(projectId);
    const sources: string[] = [];
    for (const rel of sourcesRel) {
      const abs = await this.resolveAndGuard(userId, projectId, rel);
      if (abs === root) {
        throw new FileError("Cannot compress the project root", "COMPRESS_ROOT", 400);
      }
      sources.push(abs);
    }
    const dest = await this.resolveAndGuard(userId, projectId, destinationRel, true);

    const result = await runArchiveCommand<CompressResult>({
      command: "compress",
      root,
      sources,
      dest,
      limits: archiveLimits(),
    });

    await this.auditLog.log(userId, "file.archive_created", { type: "Project", id: projectId }, {
      after: { archive: destinationRel, items: sourcesRel.length, files: result.files },
    });

    return { files: result.files, skippedLinks: result.skippedLinks };
  }

  // ── Download (stream) ──────────────────────────────────────────────────

  async getDownloadStream(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<{ stream: ReturnType<typeof createReadStream>; filename: string; size: number }> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);

    const stat = await fs.stat(target).catch(() => {
      throw new FileError("File not found", "FILE_NOT_FOUND", 404);
    });

    if (stat.isDirectory()) {
      throw new FileError("Cannot download a directory directly, use export instead", "IS_DIRECTORY", 400);
    }

    return {
      stream: createReadStream(target),
      filename: path.basename(target),
      size: stat.size,
    };
  }

  // ── Upload (write stream) ──────────────────────────────────────────────

  async writeUploadStream(
    userId: string,
    projectId: string,
    relPath: string,
    readableStream: NodeJS.ReadableStream,
    overwrite = false,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const exists = await fs.lstat(target).then(() => true).catch(() => false);
    if (exists && !overwrite) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "FILE_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const ws = createWriteStream(target);
    await pipeline(readableStream, ws);
  }

  // ── Ownership guard ────────────────────────────────────────────────────

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, deletedAt: true },
    });

    if (!project || project.deletedAt !== null) {
      throw new FileError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new FileError("You do not have access to this project", "FORBIDDEN", 403);
    }

    return project;
  }
}
