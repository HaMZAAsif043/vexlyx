import type { FastifyInstance, FastifyReply } from "fastify";
import { DeployService, DeployError } from "./service.js";
import { DeployBodySchema, ContainerActionBodySchema, LogsQuerySchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleDeployError(err: unknown, reply: FastifyReply): void {
  if (err instanceof DeployError) {
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
// ---------------------------------------------------------------------------

export async function deployRoutes(app: FastifyInstance) {
  const service = new DeployService(app.prisma);

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/deploy
  // Deploys the built Docker image to a live container via Docker Compose
  // -------------------------------------------------------------------------
  app.post(
    "/:id/deploy",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = DeployBodySchema.parse(request.body ?? {});
        const result = await service.deploy(request.userId!, id, body);
        reply.status(200);
        return result;
      } catch (err) {
        handleDeployError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/container/:action
  // Lifecycle controls: start, stop, restart, remove
  // -------------------------------------------------------------------------
  app.post(
    "/:id/container/:action",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id, action } = request.params as {
          id: string;
          action: "start" | "stop" | "restart" | "remove" | "remove-container";
        };
        ContainerActionBodySchema.parse({ action });
        const result = await service.containerAction(request.userId!, id, action);
        return result;
      } catch (err) {
        handleDeployError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/container/status
  // Inspect live Docker container status
  // -------------------------------------------------------------------------
  app.get(
    "/:id/container/status",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const result = await service.getContainerStatus(request.userId!, id);
        return result;
      } catch (err) {
        handleDeployError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/logs
  // Get container runtime logs
  // -------------------------------------------------------------------------
  app.get(
    "/:id/logs",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const query = LogsQuerySchema.parse(request.query);
        const result = await service.getContainerLogs(request.userId!, id, query.tail);
        return result;
      } catch (err) {
        handleDeployError(err, reply);
      }
    },
  );
}
