import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export class SourceDirectoryError extends Error {
  readonly code = "INVALID_BASE_DIRECTORY";
  readonly statusCode = 422;
  constructor() {
    super(
      "Base directory must be an existing directory inside this project's source, without traversal or generated directories",
    );
  }
}

export function resolveSourceDirectory(
  projectDir: string,
  baseDirectory?: string | null,
): string {
  if (!baseDirectory) return projectDir;
  try {
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?![\s\S])/.test(baseDirectory) ||
      baseDirectory
        .split("/")
        .some((part) =>
          [".", "..", ".git", "deploy", ".nixpacks"].includes(part),
        )
    )
      throw new SourceDirectoryError();
    const root = realpathSync(projectDir);
    const source = realpathSync(resolve(root, baseDirectory));
    if (!source.startsWith(root + sep) || !statSync(source).isDirectory())
      throw new SourceDirectoryError();
    return source;
  } catch {
    throw new SourceDirectoryError();
  }
}
