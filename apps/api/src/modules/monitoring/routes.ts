import type { FastifyInstance, FastifyReply } from "fastify";
import { MonitoringService, MonitoringError } from "./service.js";
import { MetricsQuerySchema } from "./schema.js";
import { registerMonitoringSocketHandlers, runMetricsCollectorJob } from "./socket.js";
import { getIO } from "../../plugins/socket.js";
import { createSocketAuthorizer } from "../../plugins/socket-auth.js";
import { MONITORING_ACCESS } from "./access.js";
import { createQueue, createWorker } from "../../config/queue.js";

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleMonitoringError(err: unknown, reply: FastifyReply): void {
  if (err instanceof MonitoringError) {
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
// BullMQ queue name for the repeatable metrics collector
// ---------------------------------------------------------------------------

const METRICS_QUEUE_NAME = "metrics-collector";

export async function monitoringRoutes(app: FastifyInstance) {
  const service = new MonitoringService(app.prisma, app.log);
  const io = getIO();

  // One rule for REST and the Socket.io room (see ./access.ts).
  const requireMonitoringAccess = app.requireRole(...MONITORING_ACCESS.roles);
  const authorize = createSocketAuthorizer(app.prisma, app.log);

  // Subscribers are re-authorized on subscribe and again before every
  // broadcast, so a demoted admin stops receiving host metrics.
  registerMonitoringSocketHandlers(io, service, app.log, authorize);

  // ---------------------------------------------------------------------------
  // BullMQ repeatable job — collect + persist server metrics every 60 seconds
  // ---------------------------------------------------------------------------

  const metricsQueue = createQueue(METRICS_QUEUE_NAME);

  const metricsWorker = createWorker<Record<string, never>>(
    METRICS_QUEUE_NAME,
    async () => {
      await runMetricsCollectorJob(io, service, app.log, authorize);
    },
    app,
    { concurrency: 1 },
  );

  app.registerQueue(metricsQueue, metricsWorker);

  // Schedule the repeatable job (upsert — safe to call on every restart)
  await metricsQueue.upsertJobScheduler(
    "collect-metrics",
    { every: 60_000 },
    { name: "collect-metrics", data: {} },
  );

  app.log.info("Metrics collector job scheduled (every 60s)");

  // ---------------------------------------------------------------------------
  // GET /api/monitoring/server — live server metrics snapshot
  // ---------------------------------------------------------------------------

  app.get(
    "/server",
    { preHandler: [requireMonitoringAccess] },
    async (_request, reply) => {
      try {
        const metrics = await service.getServerMetrics();
        return metrics;
      } catch (err) {
        handleMonitoringError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/monitoring/containers — live per-container metrics
  // ---------------------------------------------------------------------------

  app.get(
    "/containers",
    { preHandler: [requireMonitoringAccess] },
    async (_request, reply) => {
      try {
        const containers = await service.getContainerMetrics();
        return { containers };
      } catch (err) {
        handleMonitoringError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/monitoring/history?range=24h — historical snapshots from DB
  // ---------------------------------------------------------------------------

  app.get(
    "/history",
    { preHandler: [requireMonitoringAccess] },
    async (request, reply) => {
      try {
        const query = MetricsQuerySchema.parse(request.query);
        const snapshots = await service.getHistory(query.range);
        return { snapshots, range: query.range };
      } catch (err) {
        handleMonitoringError(err, reply);
      }
    },
  );
}
