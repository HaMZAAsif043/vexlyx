import type { PrismaClient } from "@prisma/client";
import type { BuildJobData } from "../build/schema.js";

interface QueuedDeploymentInput {
  projectId: string;
  commitHash: string | null;
  commitMsg: string | null;
  job: Omit<BuildJobData, "deploymentId">;
}

/**
 * Creates the QUEUED deployment row and enqueues its build job. The row has to
 * exist first because the job carries its ID, so when the enqueue fails the row
 * is marked FAILED instead of staying QUEUED forever, and the original error is
 * rethrown so the caller can release the delivery claim for GitHub's retry.
 */
export async function createAndEnqueueDeployment(
  prisma: PrismaClient,
  enqueueJob: (data: BuildJobData) => Promise<void>,
  input: QueuedDeploymentInput,
): Promise<{ id: string }> {
  const deployment = await prisma.deployment.create({
    data: {
      projectId: input.projectId,
      status: "QUEUED",
      commitHash: input.commitHash,
      commitMsg: input.commitMsg,
    },
  });

  try {
    await enqueueJob({ ...input.job, deploymentId: deployment.id });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    try {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: "FAILED",
          buildLogs: `The build could not be queued (${reason}). Push again or redeploy to retry.`,
        },
      });
    } catch (updateError) {
      console.error("Failed to mark an unqueued deployment as FAILED:", updateError);
    }
    throw error;
  }

  return deployment;
}

/**
 * True when this project already has a live (not FAILED) deployment for the
 * commit from the last 24 hours — i.e. an earlier attempt at the same delivery
 * got as far as queueing it, so a retried delivery must not queue it again.
 */
export async function hasRecentDeploymentForCommit(
  prisma: PrismaClient,
  projectId: string,
  commitHash: string | null,
): Promise<boolean> {
  if (!commitHash) return false;
  const existing = await prisma.deployment.findFirst({
    where: {
      projectId,
      commitHash,
      status: { not: "FAILED" },
      createdAt: { gte: new Date(Date.now() - 86_400_000) },
    },
    select: { id: true },
  });
  return existing !== null;
}
