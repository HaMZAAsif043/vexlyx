import { z } from "zod";
import path from "node:path";

// ---------------------------------------------------------------------------
// Blocked patterns — never allow write/delete on these filenames
// ---------------------------------------------------------------------------

const BLOCKED_WRITE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^wp-config\.php$/i,
];

const BLOCKED_READ_PATTERNS: RegExp[] = [];

// ---------------------------------------------------------------------------
// Safe path validator
// Returns the normalized relative path or throws on traversal / blocked names.
// ---------------------------------------------------------------------------

export function safePath(
  rawPath: string,
  forWrite = false,
): string {
  // Reject null bytes
  if (rawPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // Strip leading and trailing slashes so both "/index.php" and "index.php" resolve safely
  const stripped = rawPath.replace(/^[/\\]+/, "").replace(/\\/g, "/");

  // Normalize: resolve . and ..
  const normalized = path.posix.normalize(stripped);

  // After normalization a traversal attempt would produce ".." at start
  if (normalized.startsWith("..")) {
    throw new Error("Path traversal detected");
  }

  // Reject absolute paths
  if (path.posix.isAbsolute(normalized)) {
    throw new Error("Absolute paths are not allowed");
  }

  const basename = path.posix.basename(normalized);

  for (const pattern of BLOCKED_READ_PATTERNS) {
    if (pattern.test(basename)) {
      throw new Error(`Access to "${basename}" is not allowed`);
    }
  }

  if (forWrite) {
    for (const pattern of BLOCKED_WRITE_PATTERNS) {
      if (pattern.test(basename)) {
        throw new Error(`Writing to "${basename}" is not allowed`);
      }
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const ProjectIdParamSchema = z.object({
  id: z.string().min(1),
});

export const ListQuerySchema = z.object({
  path: z.string().default(""),
  depth: z.coerce.number().int().min(1).max(3).default(1),
});

export const ReadQuerySchema = z.object({
  path: z.string().min(1),
});

export const CreateBodySchema = z.object({
  path: z.string().min(1),
  content: z.string().optional().default(""),
});

export const WriteBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createOnly: z.boolean().optional().default(false),
});

export const DeleteBodySchema = z.object({
  path: z.string().min(1),
});

export const RenameBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const MkdirBodySchema = z.object({
  path: z.string().min(1),
});

export const CopyBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const MoveBodySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

const OctalModeSchema = z
  .string()
  .regex(/^[0-7]{3}$/, "Mode must be three octal digits, e.g. 644");

export const ChmodBodySchema = z.object({
  path: z.string().min(1),
  mode: OctalModeSchema,
  recursive: z.boolean().optional().default(false),
  /** Recursive only: mode for files; `mode` then applies to folders. */
  fileMode: OctalModeSchema.optional(),
});

export const ExtractBodySchema = z.object({
  path: z.string().min(1),
  /** Defaults to the archive's own folder; "." means the project root. */
  destination: z.string().min(1).optional(),
  overwrite: z.boolean().optional().default(false),
});

export const CompressBodySchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(500),
  destination: z.string().min(1),
});

export type ChmodBody = z.infer<typeof ChmodBodySchema>;
export type ExtractBody = z.infer<typeof ExtractBodySchema>;
export type CompressBody = z.infer<typeof CompressBodySchema>;
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type ReadQuery = z.infer<typeof ReadQuerySchema>;
export type WriteBody = z.infer<typeof WriteBodySchema>;
export type DeleteBody = z.infer<typeof DeleteBodySchema>;
export type RenameBody = z.infer<typeof RenameBodySchema>;
export type MkdirBody = z.infer<typeof MkdirBodySchema>;
export type CopyBody = z.infer<typeof CopyBodySchema>;
export type MoveBody = z.infer<typeof MoveBodySchema>;
