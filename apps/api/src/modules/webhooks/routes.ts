import type { FastifyInstance, FastifyReply } from "fastify";
import { WebhookService, WebhookError } from "./service.js";
import {
  GitHubWebhookQuerySchema,
  GitHubWebhookParamsSchema,
} from "./schema.js";
import { createQueue } from "../../config/queue.js";
import { BUILD_QUEUE_NAME } from "../build/service.js";
import type { BuildJobData } from "../build/schema.js";
import { registerGitHubAppWebhook } from "./github-app.js";
import { readDeliveryId } from "./delivery.js";

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleWebhookError(err: unknown, reply: FastifyReply): void {
  if (err instanceof WebhookError) {
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
// Routes — mounted at /api/webhooks
// ---------------------------------------------------------------------------

export async function webhookRoutes(app: FastifyInstance) {
  const service = new WebhookService(app.prisma, app.log, app.redis);
  const buildQueue = createQueue(BUILD_QUEUE_NAME);

  // Content type parser preserving exact raw body buffer for HMAC signature verification
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      try {
        const rawString = (body as Buffer).toString("utf8");
        (req as unknown as { rawBody: string }).rawBody = rawString;
        const parsed = JSON.parse(rawString);
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const enqueueJob = async (data: BuildJobData) => {
    await buildQueue.add("build", data, {
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    });
  };

  registerGitHubAppWebhook(app, enqueueJob);

  // -------------------------------------------------------------------------
  // POST /api/webhooks/github
  // Query param: ?projectId=...
  // Headers: x-github-event, x-hub-signature-256
  // -------------------------------------------------------------------------
  app.post("/github", async (request, reply) => {
    try {
      const query = GitHubWebhookQuerySchema.parse(request.query);
      const projectId = query.projectId;

      if (!projectId) {
        reply.status(400).send({
          error: "Missing projectId query parameter (?projectId=...)",
          code: "MISSING_PROJECT_ID",
          details: {},
        });
        return;
      }

      const event = (request.headers["x-github-event"] as string) || "push";
      const signatureHeader = request.headers["x-hub-signature-256"];
      const rawBody =
        (request as unknown as { rawBody?: string }).rawBody ||
        JSON.stringify(request.body ?? {});

      const result = await service.handleGitHubWebhook(
        projectId,
        event,
        rawBody,
        signatureHeader,
        request.body,
        enqueueJob,
        readDeliveryId(request.headers["x-github-delivery"]),
      );

      reply.status(result.ignored ? 200 : 202).send(result);
    } catch (err) {
      handleWebhookError(err, reply);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/webhooks/github/:projectId
  // Alternative route with path parameter
  // -------------------------------------------------------------------------
  app.post("/github/:projectId", async (request, reply) => {
    try {
      const params = GitHubWebhookParamsSchema.parse(request.params);
      const projectId = params.projectId;

      if (!projectId) {
        reply.status(400).send({
          error: "Missing projectId in URL path",
          code: "MISSING_PROJECT_ID",
          details: {},
        });
        return;
      }

      const event = (request.headers["x-github-event"] as string) || "push";
      const signatureHeader = request.headers["x-hub-signature-256"];
      const rawBody =
        (request as unknown as { rawBody?: string }).rawBody ||
        JSON.stringify(request.body ?? {});

      const result = await service.handleGitHubWebhook(
        projectId,
        event,
        rawBody,
        signatureHeader,
        request.body,
        enqueueJob,
        readDeliveryId(request.headers["x-github-delivery"]),
      );

      reply.status(result.ignored ? 200 : 202).send(result);
    } catch (err) {
      handleWebhookError(err, reply);
    }
  });
}
