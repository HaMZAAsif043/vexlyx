import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { EnvService } from "../env/service.js";
import { DatabaseService } from "../databases/service.js";
import { decrypt } from "../../utils/encryption.js";
import type { WordPressInstallInput, WordPressUploadInput, WordPressImportInput } from "./schema.js";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WordPressError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "WordPressError";
  }
}

// ---------------------------------------------------------------------------
// Locate build_manager.py
// ---------------------------------------------------------------------------

function getBuildManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/build_manager.py"),
    resolve(currentDir, "../../../../system/python/build_manager.py"),
    resolve(process.cwd(), "../../system/python/build_manager.py"),
    resolve(process.cwd(), "system/python/build_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/build_manager.py");
}

function runPythonCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getBuildManagerScriptPath();
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
          new WordPressError(
            `build_manager.py produced no output (stderr: ${stderr.trim()})`,
            "WP_SYSTEM_NO_OUTPUT",
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
          new WordPressError(
            `build_manager.py returned invalid JSON: ${raw}`,
            "WP_SYSTEM_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed.error || code !== 0) {
        rejectP(
          new WordPressError(
            (parsed.error as string) || "System script failed",
            (parsed.code as string) || "WP_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolveP(parsed as T);
    });

    child.on("error", (err) => {
      rejectP(
        new WordPressError(
          `Failed to spawn system build manager: ${err.message}`,
          "WP_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WordPressService {
  private envService: EnvService;
  private databaseService: DatabaseService;

  constructor(private prisma: PrismaClient) {
    this.envService = new EnvService(prisma);
    this.databaseService = new DatabaseService(prisma);
  }

  async install(
    userId: string,
    projectId: string,
    input: WordPressInstallInput,
  ) {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    const db = await this.databaseService.getById(userId, input.databaseId);
    if (db.type !== "MYSQL") {
      throw new WordPressError(
        "WordPress requires a MySQL database. Create a MySQL database first.",
        "WORDPRESS_REQUIRES_MYSQL",
        400,
      );
    }
    if (db.projectId !== projectId) {
      await this.prisma.database.update({
        where: { id: db.id },
        data: { projectId },
      });
    }

    const result = await runPythonCommand<{
      success: boolean;
      projectDir: string;
      wpContentDir: string;
    }>({
      command: "wordpress-install",
      projectDir,
    });

    // Update project type to WORDPRESS if it's not already
    if (project.type !== "WORDPRESS") {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { type: "WORDPRESS" },
      });
    }

    // Upsert database env vars -- consumed by wordpress.yml's WORDPRESS_DB_* mapping
    const envVars = [
      { key: "DB_NAME", value: db.name },
      { key: "DB_USER", value: db.dbUser },
      { key: "DB_PASSWORD", value: db.dbPassword ?? "" },
      { key: "DB_HOST", value: db.internalHost },
      { key: "DB_PREFIX", value: input.dbPrefix },
    ];
    await this.envService.bulkUpsert(userId, projectId, envVars);

    return {
      message: "WordPress installed successfully",
      ...result,
    };
  }

  async uploadAsset(
    userId: string,
    projectId: string,
    input: WordPressUploadInput,
  ) {
    await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    const result = await runPythonCommand<{
      success: boolean;
      assetType: string;
      extractedFiles: number;
      targetDir: string;
    }>({
      command: "wordpress-upload",
      projectDir,
      assetType: input.assetType,
      zipBase64: input.zipBase64,
    });

    return {
      message: `WordPress ${input.assetType} uploaded and extracted successfully`,
      ...result,
    };
  }

  async getStatus(userId: string, projectId: string) {
    await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    return runPythonCommand<{
      installed: boolean;
      coreVersion: string;
      plugins: string[];
      themes: string[];
    }>({
      command: "wordpress-status",
      projectDir,
    });
  }

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        type: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new WordPressError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new WordPressError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }

  async exportSite(
    userId: string,
    projectId: string,
  ): Promise<{ stream: ReturnType<typeof createReadStream>; filename: string }> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);
    const exportDir = join("/tmp", "vexlyx-exports", projectId);
    const filename = `wp-export-${project.id}-${Date.now()}.tar.gz`;
    const tarPath = join(exportDir, filename);

    const db = await this.prisma.database.findFirst({
      where: { projectId, type: "MYSQL" },
    });
    if (!db) {
      throw new WordPressError(
        "No MySQL database is linked to this project. Link one before exporting.",
        "WORDPRESS_NO_LINKED_DATABASE",
        400,
      );
    }
    let plainPassword: string;
    try {
      plainPassword = decrypt(db.dbPassword);
    } catch {
      throw new WordPressError("Failed to decrypt database password", "DECRYPTION_ERROR", 500);
    }

    await runPythonCommand<{ success: boolean }>({
      command: "wordpress-export",
      projectDir,
      exportDir,
      tarPath,
      dbName: db.name,
      dbUser: db.dbUser,
      dbPassword: plainPassword,
      dbHost: db.host,
    });

    const stream = createReadStream(tarPath);
    // Clean up after the stream closes
    stream.on("close", () => {
      void fs.rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
    });

    return { stream, filename };
  }

  async saveTempUpload(
    projectId: string,
    readableStream: NodeJS.ReadableStream,
    originalFilename: string,
  ): Promise<string> {
    const uploadDir = join("/tmp", "vexlyx-imports", projectId);
    await fs.mkdir(uploadDir, { recursive: true });
    const tarPath = join(uploadDir, originalFilename);
    const ws = createWriteStream(tarPath);
    await pipeline(readableStream, ws);
    return tarPath;
  }

  async importSite(
    userId: string,
    projectId: string,
    input: WordPressImportInput,
  ): Promise<{ success: boolean; message: string }> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    const db = await this.databaseService.getById(userId, input.databaseId);
    if (db.type !== "MYSQL") {
      throw new WordPressError(
        "WordPress requires a MySQL database. Create a MySQL database first.",
        "WORDPRESS_REQUIRES_MYSQL",
        400,
      );
    }
    if (db.projectId !== projectId) {
      await this.prisma.database.update({
        where: { id: db.id },
        data: { projectId },
      });
    }

    const result = await runPythonCommand<{ success: boolean }>({
      command: "wordpress-import",
      projectDir,
      tarPath: input.tarPath,
      dbName: db.name,
      dbUser: db.dbUser,
      dbPassword: db.dbPassword ?? "",
      dbHost: db.host,
    });

    // Update env vars with the linked database's credentials
    const envVars = [
      { key: "DB_NAME", value: db.name },
      { key: "DB_USER", value: db.dbUser },
      { key: "DB_PASSWORD", value: db.dbPassword ?? "" },
      { key: "DB_HOST", value: db.internalHost },
    ];
    await this.envService.bulkUpsert(userId, projectId, envVars);

    // Clean up temp upload
    await fs.rm(input.tarPath, { force: true }).catch(() => undefined);

    void project; // already validated above
    return {
      success: result.success,
      message: "WordPress site imported successfully. Redeploy to apply changes.",
    };
  }
}
