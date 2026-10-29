import { z } from "zod";

export const ProjectIdParamSchema = z.object({
  id: z.string().min(1, "Project ID is required"),
});

export type ProjectIdParam = z.infer<typeof ProjectIdParamSchema>;

export const WordPressInstallSchema = z.object({
  databaseId: z.string().min(1, "Database is required"),
  dbPrefix: z.string().max(20).default("wp_"),
});

export type WordPressInstallInput = z.infer<typeof WordPressInstallSchema>;

export const WordPressUploadSchema = z.object({
  assetType: z.enum(["plugin", "theme"]),
  zipPath: z.string().min(1, "Uploaded ZIP path is required"),
});

export type WordPressUploadInput = z.infer<typeof WordPressUploadSchema>;

export const WordPressImportSchema = z.object({
  tarPath: z.string().min(1, "Uploaded tar.gz path is required"),
  databaseId: z.string().min(1, "Database is required"),
});

export type WordPressImportInput = z.infer<typeof WordPressImportSchema>;

