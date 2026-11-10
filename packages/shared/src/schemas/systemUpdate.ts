import { z } from "zod";

// ---------------------------------------------------------------------------
// In-panel update notices (0.4.3) — the API compares the running version with
// the newest stable GitHub release, and the dashboard shows admins a banner
// pointing at the release notes and the upgrade guide. Nulls mean "not known":
// either the check is disabled or GitHub could not be reached.
// ---------------------------------------------------------------------------

export const SystemUpdateInfoSchema = z.object({
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1).nullable(),
  updateAvailable: z.boolean(),
  releaseUrl: z.string().url().nullable(),
  publishedAt: z.string().datetime().nullable(),
  checkedAt: z.string().datetime(),
  checkEnabled: z.boolean(),
  checkFailed: z.boolean(),
});
export type SystemUpdateInfo = z.infer<typeof SystemUpdateInfoSchema>;
