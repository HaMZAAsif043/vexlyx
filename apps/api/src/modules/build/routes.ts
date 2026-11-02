import type { FastifyInstance, FastifyReply } from "fastify";
import { BuildService, BuildError, createBuildProcessor, BUILD_QUEUE_NAME } from "./service.js";
import { createQueue, createWorker } from "../../config/queue.js";
import { TriggerBuildBodySchema, DeploymentListQuerySchema } from "./schema.js";
import type { BuildJobData } from "./schema.js";

// ---------------------------------------------------------------------------
// Shared error handler — same pattern as git/routes.ts
// ---------------------------------------------------------------------------

function handleBuildError(err: unknown, reply: FastifyReply): void {
  if (err instanceof BuildError) {
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
// Routes — mounted at /api/projects
// All paths are /:id/build or /:id/deployments/...
// ---------------------------------------------------------------------------

export async function buildRoutes(app: FastifyInstance) {
  const service = new BuildService(app.prisma);

  // Set up BullMQ queue + worker for builds
  const buildQueue = createQueue(BUILD_QUEUE_NAME);
  const buildWorker = createWorker<BuildJobData>(
    BUILD_QUEUE_NAME,
    createBuildProcessor(app.prisma, app.log),
    app,
  );
  app.registerQueue(buildQueue, buildWorker);

  // Helper — enqueue a build job
  const enqueueJob = async (data: BuildJobData) => {
    await buildQueue.add("build", data, {
      attempts: 1, // Builds are not retried automatically — user must re-trigger
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    });
  };

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/build
  // Trigger a new build for the project. Creates a Deployment record (QUEUED)
  // and enqueues a BullMQ job. Returns the Deployment immediately.
  // -------------------------------------------------------------------------
  app.post(
    "/:id/build",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = TriggerBuildBodySchema.parse(request.body ?? {});
        const deployment = await service.triggerBuild(
          request.userId!,
          id,
          body,
          enqueueJob,
        );
        reply.status(202);
        return deployment;
      } catch (err) {
        handleBuildError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/build-plan
  // Run Nixpacks detection over the project's current source without building
  // anything, so the dashboard can show the detected commands beside the
  // overrides stored on the project.
  // -------------------------------------------------------------------------
  app.get(
    "/:id/build-plan",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await service.getBuildPlan(request.userId!, id);
      } catch (err) {
        handleBuildError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/deployments
  // List all deployments for a project (newest first), paginated.
  // -------------------------------------------------------------------------
  app.get(
    "/:id/deployments",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = DeploymentListQuerySchema.parse(request.query);
        const { deployments, total } = await service.listDeployments(
          request.userId!,
          id,
          query,
        );
        return {
          deployments,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };
      } catch (err) {
        handleBuildError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/deployments/:deploymentId
  // Get a single deployment — used for polling build logs and status.
  // -------------------------------------------------------------------------
  app.get(
    "/:id/deployments/:deploymentId",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id, deploymentId } = request.params as {
          id: string;
          deploymentId: string;
        };
        const deployment = await service.getDeployment(
          request.userId!,
          id,
          deploymentId,
        );
        return deployment;
      } catch (err) {
        handleBuildError(err, reply);
      }
    },
  );
}
