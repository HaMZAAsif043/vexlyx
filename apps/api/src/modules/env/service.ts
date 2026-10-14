import type { PrismaClient } from "@prisma/client";
import type { EnvVar, DecryptedEnvVar } from "@vexlyx/shared";
import { encrypt, decrypt, maskValue } from "../../utils/encryption.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EnvError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "EnvError";
  }
}

// ---------------------------------------------------------------------------
// .env Parser Utility
// ---------------------------------------------------------------------------

/**
 * Parses raw .env string into key-value pairs.
 * Follows standard dotenv rules:
 * - Ignores empty lines and comments (starting with #)
 * - Supports optional `export ` prefix
 * - Handles single quotes ('...'), double quotes ("..."), and unquoted values
 * - Preserves newlines inside quoted strings
 * - Handles escaped characters (\n, \r, \t)
 */
export function parseDotEnv(content: string): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  const lines = content.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentValue = "";
  let inQuotes: '"' | "'" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";

    if (inQuotes) {
      // Continuing a multiline quoted string
      const endQuoteIndex = rawLine.indexOf(inQuotes);
      if (endQuoteIndex !== -1) {
        // Line ends the quoted section
        currentValue += "\n" + rawLine.slice(0, endQuoteIndex);
        inQuotes = null;
        if (currentKey) {
          result.push({ key: currentKey, value: unescapeValue(currentValue) });
          currentKey = null;
          currentValue = "";
        }
      } else {
        currentValue += "\n" + rawLine;
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Strip leading 'export ' if present
    const lineWithoutExport = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;

    const equalIndex = lineWithoutExport.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = lineWithoutExport.slice(0, equalIndex).trim();
    let valPart = lineWithoutExport.slice(equalIndex + 1).trim();

    // Validate key name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    // Check if value starts with quotes
    if (valPart.startsWith('"') || valPart.startsWith("'")) {
      const quoteChar = valPart[0] as '"' | "'";
      const rest = valPart.slice(1);
      const endQuoteIndex = rest.indexOf(quoteChar);

      if (endQuoteIndex !== -1) {
        // Single-line quoted value
        const inner = rest.slice(0, endQuoteIndex);
        result.push({ key, value: unescapeValue(inner) });
      } else {
        // Multiline quoted value starts here
        currentKey = key;
        currentValue = rest;
        inQuotes = quoteChar;
      }
    } else {
      // Unquoted value -- strip inline comments if separated by whitespace
      const commentIndex = valPart.search(/\s+#/);
      if (commentIndex !== -1) {
        valPart = valPart.slice(0, commentIndex).trim();
      }
      result.push({ key, value: unescapeValue(valPart) });
    }
  }

  return result;
}

function unescapeValue(val: string): string {
  return val
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

// ---------------------------------------------------------------------------
// Service Layer
// ---------------------------------------------------------------------------

export class EnvService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Lists all environment variables for a project with masked values.
   */
  async list(userId: string, projectId: string): Promise<{ variables: EnvVar[] }> {
    await this.findOwnedProject(userId, projectId);

    const records = await this.prisma.envVar.findMany({
      where: { projectId },
      orderBy: { key: "asc" },
    });

    const variables: EnvVar[] = records.map((rec) => ({
      id: rec.id,
      key: rec.key,
      maskedValue: maskValue(rec.value),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    }));

    return { variables };
  }

  /**
   * Reveals a single environment variable's decrypted value.
   */
  async reveal(
    userId: string,
    projectId: string,
    key: string,
  ): Promise<DecryptedEnvVar> {
    await this.findOwnedProject(userId, projectId);

    const record = await this.prisma.envVar.findUnique({
      where: {
        projectId_key: {
          projectId,
          key,
        },
      },
    });

    if (!record) {
      throw new EnvError(`Variable "${key}" not found`, "ENV_VAR_NOT_FOUND", 404);
    }

    let decryptedValue: string;
    try {
      decryptedValue = decrypt(record.value);
    } catch {
      throw new EnvError(
        `Could not decrypt variable "${key}". The encryption key may have changed or the stored value is corrupted — re-enter this value.`,
        "ENV_DECRYPT_FAILED",
        500,
      );
    }

    return {
      id: record.id,
      key: record.key,
      value: decryptedValue,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Creates or updates a single environment variable with AES-256-GCM encryption.
   */
  async upsert(
    userId: string,
    projectId: string,
    key: string,
    value: string,
  ): Promise<EnvVar> {
    await this.findOwnedProject(userId, projectId);

    const encryptedValue = encrypt(value);

    const record = await this.prisma.envVar.upsert({
      where: {
        projectId_key: {
          projectId,
          key,
        },
      },
      create: {
        projectId,
        key,
        value: encryptedValue,
      },
      update: {
        value: encryptedValue,
      },
    });

    return {
      id: record.id,
      key: record.key,
      maskedValue: maskValue(record.value),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Bulk upserts an array of environment variables in a single atomic transaction.
   */
  async bulkUpsert(
    userId: string,
    projectId: string,
    variables: Array<{ key: string; value: string }>,
  ): Promise<{ count: number; variables: EnvVar[] }> {
    await this.findOwnedProject(userId, projectId);

    const upsertOperations = variables.map((item) => {
      const encryptedValue = encrypt(item.value);
      return this.prisma.envVar.upsert({
        where: {
          projectId_key: {
            projectId,
            key: item.key,
          },
        },
        create: {
          projectId,
          key: item.key,
          value: encryptedValue,
        },
        update: {
          value: encryptedValue,
        },
      });
    });

    const records = await this.prisma.$transaction(upsertOperations);

    const resultVars: EnvVar[] = records.map((rec) => ({
      id: rec.id,
      key: rec.key,
      maskedValue: maskValue(rec.value),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    }));

    return {
      count: records.length,
      variables: resultVars,
    };
  }

  /**
   * Imports a raw .env file text content.
   * If overwrite is true, deletes existing variables before saving parsed ones.
   */
  async importDotEnv(
    userId: string,
    projectId: string,
    content: string,
    overwrite: boolean = false,
  ): Promise<{ count: number; variables: EnvVar[] }> {
    await this.findOwnedProject(userId, projectId);

    const parsed = parseDotEnv(content);
    if (parsed.length === 0) {
      throw new EnvError(
        "No valid environment variable definitions found in .env content",
        "NO_VALID_VARS_FOUND",
        400,
      );
    }

    if (overwrite) {
      await this.prisma.envVar.deleteMany({
        where: { projectId },
      });
    }

    return this.bulkUpsert(userId, projectId, parsed);
  }

  /**
   * Deletes a single environment variable by key.
   */
  async delete(
    userId: string,
    projectId: string,
    key: string,
  ): Promise<{ message: string }> {
    await this.findOwnedProject(userId, projectId);

    const record = await this.prisma.envVar.findUnique({
      where: {
        projectId_key: {
          projectId,
          key,
        },
      },
    });

    if (!record) {
      throw new EnvError(`Variable "${key}" not found`, "ENV_VAR_NOT_FOUND", 404);
    }

    await this.prisma.envVar.delete({
      where: {
        projectId_key: {
          projectId,
          key,
        },
      },
    });

    return { message: `Variable "${key}" deleted successfully` };
  }

  /**
   * Fetches and decrypts all environment variables for a project as a plain key-value map.
   * Used internally by DeployService and BuildProcessor to inject into Docker containers.
   */
  async getDecryptedMap(projectId: string): Promise<Record<string, string>> {
    const records = await this.prisma.envVar.findMany({
      where: { projectId },
    });

    const envMap: Record<string, string> = {};
    const failedKeys: string[] = [];

    for (const rec of records) {
      try {
        envMap[rec.key] = decrypt(rec.value);
      } catch {
        failedKeys.push(rec.key);
      }
    }

    // Security/correctness: never substitute "" for a secret that could not be
    // decrypted. A container booted with an empty password or API key fails
    // confusingly at runtime (or connects with an empty credential), and
    // nothing would point at the env layer. Fail the build/deploy instead and
    // name every affected key so the operator can re-enter them.
    if (failedKeys.length > 0) {
      throw new EnvError(
        `Could not decrypt environment variable${failedKeys.length === 1 ? "" : "s"} ${failedKeys
          .map((key) => `"${key}"`)
          .join(", ")}. The encryption key may have changed or the stored value is corrupted — re-enter ${failedKeys.length === 1 ? "this value" : "these values"} in the project's environment settings.`,
        "ENV_DECRYPT_FAILED",
        500,
      );
    }

    return envMap;
  }

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new EnvError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new EnvError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }
}
