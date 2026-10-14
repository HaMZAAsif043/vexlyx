import type { Server as SocketIOServer } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import { MonitoringService } from "./service.js";
import type { ServerMetrics, ThresholdConfig } from "@vexlyx/shared";
import {
  SubscriptionGate,
  authorizeSocketSubscription,
  type SocketAuthorizer,
} from "../../plugins/socket-auth.js";
import { MONITORING_ACCESS } from "./access.js";

// ---------------------------------------------------------------------------
// Default alert thresholds (can be made configurable via env later)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  cpuThreshold: 80,
  ramThreshold: 85,
  diskThreshold: 90,
};

// ---------------------------------------------------------------------------
// One shared push timer for the whole "metrics" room
// ---------------------------------------------------------------------------

const METRICS_ROOM = "metrics";
const PUSH_INTERVAL_MS = 5_000;

let pushTimer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;

// ---------------------------------------------------------------------------
// Threshold alert state & cooldown tracking
// Prevents spamming alerts every 5 seconds when a metric stays above threshold.
// Alerts fire once upon crossing the threshold, with a 5-minute cooldown
// before any repeat notification, and reset once the metric drops below limit.
// ---------------------------------------------------------------------------

const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 minutes
const lastAlertTimes = new Map<string, number>();
const activeBreaches = new Set<string>();

function checkThresholds(
  io: SocketIOServer,
  metrics: ServerMetrics,
  thresholds: ThresholdConfig,
): void {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();

  const checks: Array<{
    type: "cpu" | "ram" | "disk";
    value: number;
    threshold: number;
    name: string;
  }> = [
    { type: "cpu", value: metrics.cpuPercent, threshold: thresholds.cpuThreshold, name: "CPU" },
    { type: "ram", value: metrics.ramPercent, threshold: thresholds.ramThreshold, name: "RAM" },
    { type: "disk", value: metrics.diskPercent, threshold: thresholds.diskThreshold, name: "Disk" },
  ];

  for (const { type, value, threshold, name } of checks) {
    if (value > threshold) {
      const lastAlert = lastAlertTimes.get(type) ?? 0;
      const wasActive = activeBreaches.has(type);

      // Alert if this is a new breach OR if cooldown has expired
      if (!wasActive || now - lastAlert >= ALERT_COOLDOWN_MS) {
        lastAlertTimes.set(type, now);
        activeBreaches.add(type);

        io.to(METRICS_ROOM).emit("alert:threshold", {
          type,
          value,
          threshold,
          message: `${name} usage is ${value.toFixed(1)}% (threshold: ${threshold}%)`,
          triggeredAt: timestamp,
        });
      }
    } else {
      // Metric recovered below threshold — reset active breach state
      activeBreaches.delete(type);
    }
  }
}

// ---------------------------------------------------------------------------
// Re-validate subscribers, then push a single snapshot to the metrics room
// ---------------------------------------------------------------------------

/**
 * Removes sockets that are no longer allowed to read host metrics (e.g. an
 * admin demoted after joining) from the room and tells them so. The role is read
 * fresh from the database, once per distinct user, before every broadcast, so a
 * revoked role stops receiving data within one push interval.
 *
 * @returns how many authorized subscribers remain
 */
async function removeUnauthorizedSubscribers(
  io: SocketIOServer,
  authorize: SocketAuthorizer,
): Promise<number> {
  const sockets = await io.in(METRICS_ROOM).fetchSockets();
  if (sockets.length === 0) return 0;

  const userIds = [...new Set(sockets.map((s) => s.data.userId as string | undefined))];
  const verdicts = new Map<string | undefined, boolean>();
  await Promise.all(
    userIds.map(async (id) => {
      verdicts.set(id, await authorize(id, MONITORING_ACCESS));
    }),
  );

  let remaining = 0;
  for (const socket of sockets) {
    if (verdicts.get(socket.data.userId as string | undefined)) {
      remaining += 1;
      continue;
    }
    socket.leave(METRICS_ROOM);
    socket.emit("metrics:forbidden", {
      error: "You do not have permission to perform this action",
      code: "FORBIDDEN_ROLE",
      details: {},
    });
  }
  return remaining;
}

async function pushMetrics(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: SocketAuthorizer,
  options: { checkAlerts?: boolean; collectWhenEmpty?: boolean } = {},
): Promise<{ server: ServerMetrics | null; subscribers: number }> {
  const { checkAlerts = true, collectWhenEmpty = true } = options;
  try {
    const subscribers = await removeUnauthorizedSubscribers(io, authorize);

    // The live timer has nothing to do for an empty room. The collector job
    // still needs a reading to persist, so it collects regardless.
    if (subscribers === 0 && !collectWhenEmpty) {
      return { server: null, subscribers: 0 };
    }

    const [server, containers] = await Promise.all([
      service.getServerMetrics(),
      service.getContainerMetrics(),
    ]);

    if (subscribers > 0) {
      io.to(METRICS_ROOM).emit("metrics:server", server);
      io.to(METRICS_ROOM).emit("metrics:containers", containers);
    }

    if (checkAlerts) {
      checkThresholds(io, server, DEFAULT_THRESHOLDS);
    }

    return { server, subscribers };
  } catch (err) {
    logger.error({ err }, "Failed to collect metrics for Socket.io push");
    return { server: null, subscribers: 0 };
  }
}

// ---------------------------------------------------------------------------
// Shared push timer (5-second cadence): one collection per tick no matter how
// many tabs/admins are subscribed; stops itself once the room is empty.
// ---------------------------------------------------------------------------

function ensurePushTimer(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: SocketAuthorizer,
): void {
  if (pushTimer) return;

  pushTimer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    void pushMetrics(io, service, logger, authorize, { collectWhenEmpty: false })
      .then(({ subscribers }) => {
        if (subscribers === 0) stopPushTimer();
      })
      .finally(() => {
        tickRunning = false;
      });
  }, PUSH_INTERVAL_MS);
}

function stopPushTimer(): void {
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
}

/** Stops the shared push timer. For tests and graceful shutdown. */
export function stopMetricsPush(): void {
  stopPushTimer();
  tickRunning = false;
}

// ---------------------------------------------------------------------------
// Register socket event handlers
// ---------------------------------------------------------------------------

export function registerMonitoringSocketHandlers(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: SocketAuthorizer,
): void {
  io.on("connection", (socket) => {
    const gate = new SubscriptionGate();

    // --- Subscribe to live metrics (same rule as the REST routes) ---
    socket.on("subscribe:metrics", async () => {
      const token = gate.begin();
      const allowed = await authorizeSocketSubscription(
        authorize,
        socket,
        MONITORING_ACCESS,
        "metrics:forbidden",
      );
      // Left (or disconnected) while the role lookup was pending: do not join.
      if (!allowed || !gate.isCurrent(token)) return;

      await socket.join(METRICS_ROOM);

      // Send an immediate snapshot on join so the client doesn't wait 5s
      try {
        const [server, containers] = await Promise.all([
          service.getServerMetrics(),
          service.getContainerMetrics(),
        ]);
        if (!gate.isCurrent(token)) return;
        socket.emit("metrics:server", server);
        socket.emit("metrics:containers", containers);
      } catch (err) {
        logger.error({ socketId: socket.id, err }, "Initial metrics push failed");
      }

      if (!gate.isCurrent(token)) return;
      ensurePushTimer(io, service, logger, authorize);
      logger.debug({ socketId: socket.id }, "Subscribed to metrics");
    });

    // --- Unsubscribe from live metrics ---
    socket.on("unsubscribe:metrics", async () => {
      gate.cancel();
      await socket.leave(METRICS_ROOM);
      logger.debug({ socketId: socket.id }, "Unsubscribed from metrics");
    });

    // --- Cleanup on disconnect (the timer stops itself once the room is empty) ---
    socket.on("disconnect", () => {
      gate.cancel();
    });
  });
}

// ---------------------------------------------------------------------------
// Background collector — called by BullMQ repeatable job every 60 seconds
// Saves a DB snapshot AND pushes live update to all subscribed sockets.
// ---------------------------------------------------------------------------

export async function runMetricsCollectorJob(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: SocketAuthorizer,
): Promise<void> {
  const { server } = await pushMetrics(io, service, logger, authorize);

  if (server) {
    try {
      await service.saveSnapshot(server);
    } catch (err) {
      logger.error({ err }, "Failed to persist metric snapshot");
    }

    try {
      // Prune >30d old snapshots once per collection cycle
      await service.pruneOldSnapshots();
    } catch (err) {
      logger.error({ err }, "Failed to prune old metric snapshots");
    }
  }
}
