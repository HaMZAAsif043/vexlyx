import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared path validator — used by API and can be imported by dashboard
// ---------------------------------------------------------------------------

export type FileNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  mtime?: string;
  extension?: string;
  /** Octal permission bits, e.g. "644". */
  mode?: string;
  children?: FileNode[];
};

export const FileNodeSchema: z.ZodType<FileNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "dir"]),
    size: z.number().optional(),
    mtime: z.string().optional(),
    extension: z.string().optional(),
    mode: z.string().optional(),
    children: z.array(FileNodeSchema).optional(),
  }),
);

// ---------------------------------------------------------------------------
// File operation query / body schemas
// ---------------------------------------------------------------------------

export const ListFilesQuerySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().default("/"),
  depth: z.coerce.number().int().min(1).max(3).default(1),
});

export const ReadFileQuerySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
});

export const CreateFileBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  content: z.string().optional().default(""),
});

export const WriteFileBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  createOnly: z.boolean().optional(),
});

export const DeleteNodeBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
});

export const RenameBodySchema = z.object({
  projectId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

export const MkdirBodySchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
});

export const CopyBodySchema = z.object({
  projectId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

export const MoveBodySchema = z.object({
  projectId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

// ---------------------------------------------------------------------------
// SFTP schemas
// ---------------------------------------------------------------------------

export const SftpUserSchema = z.object({
  id: z.string(),
  linuxUsername: z.string(),
  isEnabled: z.boolean(),
  sshPublicKeys: z.array(z.string()),
  createdAt: z.string(),
});

export type SftpUser = z.infer<typeof SftpUserSchema>;

export const SftpAddSshKeyBodySchema = z.object({
  publicKey: z.string().min(20),
});

export type SftpAddSshKeyBody = z.infer<typeof SftpAddSshKeyBodySchema>;
