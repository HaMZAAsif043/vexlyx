import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import type { MonitoringService } from "./service.js";
import type { SocketAuthorizer } from "../../plugins/socket-auth.js";
import { MONITORING_ACCESS } from "./access.js";

// config/env.ts validates process.env at import time
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { registerMonitoringSocketHandlers, runMetricsCollectorJob, stopMetricsPush } = await import(
  "./socket.js"
);

type Handler = () => Promise<void>;

interface FakeSocket {
  id: string;
  data: { userId?: string };
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  handlers: Map<string, Handler>;
}

function harness(authorize: SocketAuthorizer) {
  const room = new Set<FakeSocket>();
  const roomEmit = vi.fn();
  let onConnection: (s: FakeSocket) => void = () => undefined;

  const io = {
    on: vi.fn((_event: string, cb: typeof onConnection) => {
      onConnection = cb;
    }),
    in: vi.fn(() => ({ fetchSockets: async () => [...room] })),
    to: vi.fn(() => ({ emit: roomEmit })),
  } as unknown as SocketIOServer;

  const service = {
    getServerMetrics: vi.fn(async () => ({ cpuPercent: 1, ramPercent: 1, diskPercent: 1 })),
    getContainerMetrics: vi.fn(async () => []),
    saveSnapshot: vi.fn(async () => undefined),
    pruneOldSnapshots: vi.fn(async () => undefined),
  };
  const logger = { error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;

  registerMonitoringSocketHandlers(io, service as unknown as MonitoringService, logger, authorize);

  function connect(userId?: string): FakeSocket {
    const handlers = new Map<string, Handler>();
    const socket: FakeSocket = {
      id: `sock-${Math.random().toString(36).slice(2, 8)}`,
      data: { userId },
      handlers,
      join: vi.fn(async () => {
        room.add(socket);
      }),
      leave: vi.fn(async () => {
        room.delete(socket);
      }),
      emit: vi.fn(),
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, handler);
      }),
    };
    onConnection(socket);
    return socket;
  }

  return { io, service, logger, room, roomEmit, connect };
}

const allowAll: SocketAuthorizer = async () => true;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stopMetricsPush();
  vi.useRealTimers();
});

describe("subscribe:metrics authorization (#45)", () => {
  it("authorizes with the rule shared with the HTTP routes", async () => {
    const authorize = vi.fn<SocketAuthorizer>(async () => true);
    const { connect } = harness(authorize);
    const socket = connect("admin-1");

    await socket.handlers.get("subscribe:metrics")!();

    expect(MONITORING_ACCESS).toEqual({ roles: ["ADMIN"] });
    expect(authorize).toHaveBeenCalledWith("admin-1", MONITORING_ACCESS);
  });

  it("lets an admin join and receive an initial snapshot", async () => {
    const { connect, room, service } = harness(allowAll);
    const socket = connect("admin-1");

    await socket.handlers.get("subscribe:metrics")!();

    expect(room.has(socket)).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith("metrics:server", expect.objectContaining({ cpuPercent: 1 }));
    expect(service.getServerMetrics).toHaveBeenCalledTimes(1);
  });

  it("denies a non-admin: no join, no metrics, explicit forbidden event", async () => {
    const { connect, room, service } = harness(async () => false);
    const socket = connect("user-1");

    await socket.handlers.get("subscribe:metrics")!();

    expect(room.size).toBe(0);
    expect(service.getServerMetrics).not.toHaveBeenCalled();
    expect(service.getContainerMetrics).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "metrics:forbidden",
      expect.objectContaining({ code: "FORBIDDEN_ROLE" }),
    );
  });

  it("denies a socket with no resolved identity", async () => {
    const authorize = vi.fn<SocketAuthorizer>(async (id) => id !== undefined);
    const { connect, room } = harness(authorize);
    const socket = connect(undefined);

    await socket.handlers.get("subscribe:metrics")!();

    expect(room.size).toBe(0);
  });

  it("does not join when the client unsubscribes while the role lookup is pending", async () => {
    let allow!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const { connect, room } = harness(() => pending);
    const socket = connect("admin-1");

    const subscribing = socket.handlers.get("subscribe:metrics")!();
    await socket.handlers.get("unsubscribe:metrics")!();
    allow(true);
    await subscribing;

    expect(room.size).toBe(0);
  });
});

describe("live pushes re-validate subscribers (#45)", () => {
  it("collects once per tick no matter how many tabs are subscribed", async () => {
    const { connect, service, roomEmit } = harness(allowAll);
    const tabs = [connect("admin-1"), connect("admin-1"), connect("admin-2")];
    for (const tab of tabs) await tab.handlers.get("subscribe:metrics")!();
    service.getServerMetrics.mockClear();
    service.getContainerMetrics.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(service.getServerMetrics).toHaveBeenCalledTimes(1);
    expect(service.getContainerMetrics).toHaveBeenCalledTimes(1);
    expect(roomEmit).toHaveBeenCalledWith("metrics:server", expect.anything());
  });

  it("removes a demoted admin from the room before the next broadcast", async () => {
    let admin = true;
    const { connect, room, roomEmit } = harness(async () => admin);
    const socket = connect("admin-1");
    await socket.handlers.get("subscribe:metrics")!();
    expect(room.has(socket)).toBe(true);

    admin = false;
    socket.emit.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.leave).toHaveBeenCalledWith("metrics");
    expect(room.has(socket)).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith(
      "metrics:forbidden",
      expect.objectContaining({ code: "FORBIDDEN_ROLE" }),
    );
    // Nobody authorized is left, so nothing is broadcast.
    expect(roomEmit).not.toHaveBeenCalledWith("metrics:server", expect.anything());
  });

  it("keeps broadcasting to the remaining admin when only another user was demoted", async () => {
    const roles = new Map([["admin-1", true], ["admin-2", true]]);
    const { connect, room, roomEmit } = harness(async (id) => roles.get(id ?? "") === true);
    const kept = connect("admin-1");
    const demoted = connect("admin-2");
    await kept.handlers.get("subscribe:metrics")!();
    await demoted.handlers.get("subscribe:metrics")!();

    roles.set("admin-2", false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(room.has(kept)).toBe(true);
    expect(room.has(demoted)).toBe(false);
    expect(roomEmit).toHaveBeenCalledWith("metrics:server", expect.anything());
  });

  it("looks each distinct user up once per tick", async () => {
    const authorize = vi.fn<SocketAuthorizer>(async () => true);
    const { connect } = harness(authorize);
    for (const id of ["admin-1", "admin-1", "admin-2"]) {
      await connect(id).handlers.get("subscribe:metrics")!();
    }
    authorize.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("stops collecting once the room is empty", async () => {
    const { connect, service } = harness(allowAll);
    const socket = connect("admin-1");
    await socket.handlers.get("subscribe:metrics")!();
    await socket.handlers.get("unsubscribe:metrics")!();
    service.getServerMetrics.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.getServerMetrics).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.getServerMetrics).not.toHaveBeenCalled();
  });
});

describe("runMetricsCollectorJob", () => {
  it("persists a snapshot even when nobody is subscribed", async () => {
    const { io, service, logger } = harness(allowAll);

    await runMetricsCollectorJob(io, service as unknown as MonitoringService, logger, allowAll);

    expect(service.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(service.pruneOldSnapshots).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast to a subscriber who is no longer an admin", async () => {
    let admin = true;
    const authorize: SocketAuthorizer = async () => admin;
    const { io, connect, service, logger, roomEmit } = harness(authorize);
    const socket = connect("admin-1");
    await socket.handlers.get("subscribe:metrics")!();
    roomEmit.mockClear();

    admin = false;
    await runMetricsCollectorJob(io, service as unknown as MonitoringService, logger, authorize);

    expect(socket.leave).toHaveBeenCalledWith("metrics");
    expect(roomEmit).not.toHaveBeenCalledWith("metrics:server", expect.anything());
    expect(service.saveSnapshot).toHaveBeenCalledTimes(1);
  });
});
