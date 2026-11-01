import { z } from "zod";

// ---------------------------------------------------------------------------
// Trigger build — optional overrides of the project-level defaults
// ---------------------------------------------------------------------------

export const TriggerBuildBodySchema = z.object({
  installCmd: z.string().max(500).optional(),
  buildCmd: z.string().max(500).optional(),
});

export type TriggerBuildBody = z.infer<typeof TriggerBuildBodySchema>;

// ---------------------------------------------------------------------------
// Deployment list query — simple pagination
// ---------------------------------------------------------------------------

export const DeploymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type DeploymentListQuery = z.infer<typeof DeploymentListQuerySchema>;

// ---------------------------------------------------------------------------
// BullMQ job data shape — what goes into the build queue
// ---------------------------------------------------------------------------

export interface BuildJobData {
  deploymentId: string;
  projectId: string;
  userId: string;
  projectDir: string;
  imageName: string;
  installCmd: string | null;
  buildCmd: string | null;
}
