import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BuildJobData } from "../build/schema.js";
import { resolve } from "node:path";
import { decrypt } from "../../utils/encryption.js";
import { env } from "../../config/env.js";
import { WebhookError, WebhookService } from "./service.js";
import { claimDelivery, readDeliveryId, releaseDelivery } from "./delivery.js";

interface GitHubAppPayload {
  action?: string;
  ref?: string;
  after?: string;
  head_commit?: { id?: string; message?: string } | null;
  installation?: { id?: number; suspended_at?: string | null };
  repository?: { id?: number };
  repositories_removed?: Array<{ id?: number }>;
}

export function registerGitHubAppWebhook(
  app: FastifyInstance,
  enqueueJob: (data: BuildJobData) => Promise<void>,
) {
  const signatures = new WebhookService(app.prisma, app.log);

  app.post("/github-app", async (request, reply) => {
    const githubApp = await app.prisma.gitHubApp.findUnique({ where: { id: "singleton" } });
    if (!githubApp) throw new WebhookError("GitHub App is not configured", "GITHUB_APP_NOT_CONFIGURED", 404);

    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    if (!signatures.verifySignature(
      decrypt(githubApp.encryptedWebhookSecret),
      rawBody,
      request.headers["x-hub-signature-256"],
    )) {
      throw new WebhookError("Invalid GitHub webhook signature", "INVALID_WEBHOOK_SIGNATURE", 401);
    }

    const deliveryId = readDeliveryId(request.headers["x-github-delivery"]);
    if (!deliveryId) throw new WebhookError("Missing GitHub delivery ID", "MISSING_DELIVERY_ID", 400);
    if (!(await claimDelivery(app.redis, deliveryId))) {
      return reply.status(200).send({ success: true, ignored: true, reason: "duplicate_delivery" });
    }

    try {
      const eventHeader = request.headers["x-github-event"];
      const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
      const payload = request.body as GitHubAppPayload;
      const installationId = payload.installation?.id;
      if (!event || !installationId) return reply.status(200).send({ success: true, ignored: true });

      if (event === "push") {
        const repositoryId = payload.repository?.id;
        if (!repositoryId) throw new WebhookError("Missing repository ID", "MISSING_REPOSITORY_ID", 400);
        const branch = (payload.ref ?? "").replace(/^refs\/heads\//, "");
        const projects = await app.prisma.project.findMany({
          where: {
            githubRepoId: BigInt(repositoryId),
            githubConnectionStatus: "CONNECTED",
            githubInstallation: { installationId: BigInt(installationId), status: "CONNECTED" },
            deletedAt: null,
          },
          select: { id: true, userId: true, branch: true, buildCmd: true },
        });
        const matching = projects.filter((project) => project.branch === branch);
        for (const project of matching) {
          const deployment = await app.prisma.deployment.create({
            data: {
              projectId: project.id,
              status: "QUEUED",
              commitHash: payload.head_commit?.id ?? payload.after ?? null,
              commitMsg: payload.head_commit?.message ?? null,
            },
          });
          await enqueueJob({
            deploymentId: deployment.id,
            projectId: project.id,
            userId: project.userId,
            projectDir: resolve(env.PROJECTS_DIR, project.id),
            imageName: `${env.NIXPACKS_IMAGE_PREFIX}-${project.id}`,
            buildCmd: project.buildCmd,
          });
        }
        return reply.status(matching.length ? 202 : 200).send({ success: true, deploymentsQueued: matching.length });
      }

      if (event === "installation") {
        const action = payload.action;
        const status = action === "suspend" ? "SUSPENDED" : action === "deleted" ? "DISCONNECTED" : "CONNECTED";
        const reason = action === "suspend" ? "GitHub App installation suspended" : action === "deleted" ? "GitHub App uninstalled" : null;
        const installation = await app.prisma.gitHubInstallation.updateMany({
          where: { installationId: BigInt(installationId) },
          data: {
            status,
            suspendedAt: action === "suspend" ? new Date() : null,
            disconnectedAt: action === "deleted" ? new Date() : null,
          },
        });
        if (installation.count && status !== "CONNECTED") {
          await app.prisma.project.updateMany({
            where: { githubInstallation: { installationId: BigInt(installationId) } },
            data: { githubConnectionStatus: status, githubDisconnectReason: reason },
          });
        }
        if (installation.count && status === "CONNECTED") {
          await app.prisma.project.updateMany({
            where: { githubInstallation: { installationId: BigInt(installationId) }, githubConnectionStatus: "SUSPENDED" },
            data: { githubConnectionStatus: "CONNECTED", githubDisconnectReason: null },
          });
        }
        return reply.send({ success: true });
      }

      if (event === "installation_repositories" && payload.action === "removed") {
        const removedIds = (payload.repositories_removed ?? [])
          .map((repository) => repository.id)
          .filter((id): id is number => typeof id === "number")
          .map(BigInt);
        if (removedIds.length) {
          await app.prisma.project.updateMany({
            where: {
              githubInstallation: { installationId: BigInt(installationId) },
              githubRepoId: { in: removedIds },
            },
            data: {
              githubConnectionStatus: "REPOSITORY_REMOVED",
              githubDisconnectReason: "Repository access was removed from the GitHub App installation",
            },
          });
        }
        return reply.send({ success: true });
      }

      return reply.send({ success: true, ignored: true });
    } catch (error) {
      await releaseDelivery(app.redis, deliveryId);
      throw error;
    }
  });
}
