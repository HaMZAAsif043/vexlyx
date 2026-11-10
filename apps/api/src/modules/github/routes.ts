import { GitHubApiError } from "./client.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AuditLogService } from "../audit-log/service.js";
import { SESSION_COOKIE } from "../../plugins/auth.js";
import { env } from "../../config/env.js";
import { GitHubError, GitHubService } from "./service.js";
import {
  ConfigureGitHubAppSchema,
  GitHubCallbackQuerySchema,
  GitHubRepositoryListQuerySchema,
} from "./schema.js";

const IdParamsSchema = z.object({ id: z.string().min(1) });
const RepositoryParamsSchema = z.object({ id: z.string().min(1), repositoryId: z.string().regex(/^\d+$/) });
const ManifestCallbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

function handleGitHubError(error: unknown, reply: FastifyReply): void {
  if (error instanceof GitHubError || error instanceof GitHubApiError) {
    reply.status(error.statusCode).send({ error: error.message, code: error.code, details: {} });
    return;
  }
  throw error;
}

export async function githubRoutes(app: FastifyInstance) {
  const service = new GitHubService(
    app.prisma,
    app.redis,
    new AuditLogService(app.prisma, app.log),
  );
  const sessionId = (request: { cookies: Record<string, string | undefined> }) => request.cookies[SESSION_COOKIE] ?? "";

  app.get("/app", { preHandler: [app.requireAuth] }, async (_request, reply) => {
    try {
      return await service.getAppStatus();
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.post("/app/manifest", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      return await service.createManifest(request.userId!, sessionId(request));
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.get("/app/manifest/callback", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      const query = ManifestCallbackSchema.parse(request.query);
      await service.completeManifest(request.userId!, sessionId(request), query.state, query.code);
      return reply.redirect(`${env.CORS_ORIGIN}/settings?github=app-created`);
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.put("/app", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    try {
      return await service.configureApp(request.userId!, ConfigureGitHubAppSchema.parse(request.body));
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.post("/installations/connect", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      return await service.createInstallationUrl(request.userId!, sessionId(request));
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.get("/installations/callback", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const query = GitHubCallbackQuerySchema.parse(request.query);
      await service.completeInstallation(
        request.userId!,
        sessionId(request),
        query.state,
        query.code,
        query.installation_id,
      );
      return reply.redirect(`${env.CORS_ORIGIN}/settings?github=connected`);
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.get("/installations", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      return { installations: await service.listInstallations(request.userId!) };
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.delete("/installations/:id", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = IdParamsSchema.parse(request.params);
      await service.disconnectInstallation(request.userId!, id);
      return reply.status(204).send();
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.get("/installations/:id/repositories", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = IdParamsSchema.parse(request.params);
      const query = GitHubRepositoryListQuerySchema.parse(request.query);
      return await service.listRepositories(request.userId!, id, query);
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });

  app.get("/installations/:id/repositories/:repositoryId/branches", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, repositoryId } = RepositoryParamsSchema.parse(request.params);
      return { branches: await service.listBranches(request.userId!, id, repositoryId) };
    } catch (error) {
      handleGitHubError(error, reply);
    }
  });
}
