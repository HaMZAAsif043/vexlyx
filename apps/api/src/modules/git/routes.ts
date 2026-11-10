import { GitHubApiError } from "../github/client.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { GitService, GitError } from "./service.js";
import { ConnectRepoSchema } from "./schema.js";
import { ConnectGitHubRepositorySchema } from "@vexlyx/shared";
import { GitHubError, GitHubService } from "../github/service.js";
import { AuditLogService } from "../audit-log/service.js";

// ---------------------------------------------------------------------------
// Shared error handler — mirrors the pattern in projects/routes.ts
// ---------------------------------------------------------------------------

function handleGitError(err: unknown, reply: FastifyReply): void {
  if (err instanceof GitHubError || err instanceof GitHubApiError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  if (err instanceof GitError) {
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      details: {},
    });
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Routes — mounted at /api/projects (prefix shared with project routes)
// All paths are /:id/git/...
// ---------------------------------------------------------------------------

export async function gitRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const github = new GitHubService(app.prisma, app.redis, auditLog);
  const service = new GitService(app.prisma, github, auditLog);

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/git
  // Returns git metadata: current URL, branch, SSH public key, webhook URL.
  // -------------------------------------------------------------------------
  app.get(
    "/:id/git",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await service.getMetadata(request.userId!, id);
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/git/connect
  // Clone (or re-pull) the connected repository into the project workspace.
  // Body: { gitUrl, branch, isPrivate? }
  // -------------------------------------------------------------------------
  app.post(
    "/:id/git/connect",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const data = ConnectRepoSchema.parse(request.body);
        const metadata = await service.connectRepo(request.userId!, id, data);
        return metadata;
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );

  app.post(
    "/:id/git/connect-github",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await service.connectGitHubRepository(
          request.userId!,
          id,
          ConnectGitHubRepositorySchema.parse(request.body),
        );
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );

  app.post(
    "/:id/git/disconnect-github",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await service.disconnectGitHubRepository(request.userId!, id);
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/git/ssh-key
  // Generate a new Ed25519 key pair for this project.
  // Returns { publicKey } — user copies this into GitHub/GitLab Deploy Keys.
  // Overwrites any previously generated key for this project.
  // -------------------------------------------------------------------------
  app.post(
    "/:id/git/ssh-key",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const result = await service.generateSshKey(request.userId!, id);
        reply.status(201);
        return result;
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/git/webhook-secret/rotate
  // Rotate / regenerate the HMAC-SHA256 webhook secret for this project.
  // -------------------------------------------------------------------------
  app.post(
    "/:id/git/webhook-secret/rotate",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const result = await service.rotateWebhookSecret(request.userId!, id);
        reply.status(200);
        return result;
      } catch (err) {
        handleGitError(err, reply);
      }
    },
  );
}
