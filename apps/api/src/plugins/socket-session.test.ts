import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server as SocketIOServer } from "socket.io";
import {
  disconnectSessionSockets,
  disconnectUserSockets,
  sessionRoom,
  startSessionSweep,
  sweepInvalidSockets,
  type SessionSweepDeps,
} from "./socket-session.js";

function ioWithRooms() {
  const disconnectSockets = vi.fn();
  const inRoom = vi.fn().mockReturnValue({ disconnectSockets });
  return { io: { in: inRoom } as unknown as SocketIOServer, inRoom, disconnectSockets };
}

describe("disconnect helpers (#64)", () => {
  it("disconnects exactly the sockets opened with a session", () => {
    const { io, inRoom, disconnectSockets } = ioWithRooms();

    disconnectSessionSockets(io, "sess-1");

    expect(inRoom).toHaveBeenCalledWith("session:sess-1");
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it("disconnects every socket of a user", () => {
    const { io, inRoom, disconnectSockets } = ioWithRooms();

    disconnectUserSockets(io, "u1");

    expect(inRoom).toHaveBeenCalledWith("user:u1");
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it("is a no-op before the socket server exists", () => {
    expect(() => disconnectSessionSockets(null, "sess-1")).not.toThrow();
    expect(() => disconnectUserSockets(null, "u1")).not.toThrow();
  });

  it("uses distinct room names for sessions and users", () => {
    expect(sessionRoom("abc")).not.toBe("user:abc");
  });
});

function fakeSocket(data: Record<string, unknown>) {
  return { data, disconnect: vi.fn() };
}

function ioWithSockets(sockets: ReturnType<typeof fakeSocket>[]) {
  return { fetchSockets: vi.fn().mockResolvedValue(sockets) } as unknown as SocketIOServer;
}

const logger = () => ({ error: vi.fn(), debug: vi.fn() });

function deps(overrides: Partial<SessionSweepDeps> = {}): SessionSweepDeps & {
  isSessionValid: ReturnType<typeof vi.fn>;
  existingUserIds: ReturnType<typeof vi.fn>;
} {
  return {
    isSessionValid: vi.fn().mockResolvedValue(true),
    existingUserIds: vi.fn(async (ids: string[]) => new Set(ids)),
    ...overrides,
  } as never;
}

describe("sweepInvalidSockets (#64)", () => {
  it("keeps sockets whose session and user are still valid", async () => {
    const socket = fakeSocket({ userId: "u1", sessionId: "s1" });

    const count = await sweepInvalidSockets(ioWithSockets([socket]), deps(), logger());

    expect(count).toBe(0);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects a socket whose session has ended or expired", async () => {
    const live = fakeSocket({ userId: "u1", sessionId: "live" });
    const dead = fakeSocket({ userId: "u1", sessionId: "expired" });
    const d = deps({
      isSessionValid: vi.fn(async (sessionId: string) => sessionId === "live"),
    });

    const count = await sweepInvalidSockets(ioWithSockets([live, dead]), d, logger());

    expect(count).toBe(1);
    expect(dead.disconnect).toHaveBeenCalledWith(true);
    expect(live.disconnect).not.toHaveBeenCalled();
  });

  it("checks that the session still belongs to the socket's user", async () => {
    const socket = fakeSocket({ userId: "u1", sessionId: "s1" });
    const d = deps();

    await sweepInvalidSockets(ioWithSockets([socket]), d, logger());

    expect(d.isSessionValid).toHaveBeenCalledWith("s1", "u1");
  });

  it("disconnects sockets of users that no longer exist", async () => {
    const ghost = fakeSocket({ userId: "deleted", sessionId: "s1" });
    const d = deps({ existingUserIds: vi.fn(async () => new Set<string>()) });

    const count = await sweepInvalidSockets(ioWithSockets([ghost]), d, logger());

    expect(count).toBe(1);
    expect(ghost.disconnect).toHaveBeenCalledWith(true);
  });

  it.each([
    ["no session id", { userId: "u1" }],
    ["no user id", { sessionId: "s1" }],
    ["no identity at all", {}],
  ])("disconnects a socket with %s", async (_label, data) => {
    const socket = fakeSocket(data);

    const count = await sweepInvalidSockets(ioWithSockets([socket]), deps(), logger());

    expect(count).toBe(1);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("looks users up once for all sockets, de-duplicated", async () => {
    const sockets = [
      fakeSocket({ userId: "u1", sessionId: "a" }),
      fakeSocket({ userId: "u1", sessionId: "b" }),
      fakeSocket({ userId: "u2", sessionId: "c" }),
    ];
    const d = deps();

    await sweepInvalidSockets(ioWithSockets(sockets), d, logger());

    expect(d.existingUserIds).toHaveBeenCalledTimes(1);
    expect(d.existingUserIds).toHaveBeenCalledWith(["u1", "u2"]);
  });

  it("does no lookups when nobody is connected", async () => {
    const d = deps();

    await expect(sweepInvalidSockets(ioWithSockets([]), d, logger())).resolves.toBe(0);
    expect(d.existingUserIds).not.toHaveBeenCalled();
  });

  it("disconnects nobody and logs when a dependency fails (no mass logout on a blip)", async () => {
    const socket = fakeSocket({ userId: "u1", sessionId: "s1" });
    const log = logger();
    const d = deps({ isSessionValid: vi.fn().mockRejectedValue(new Error("redis down")) });

    const count = await sweepInvalidSockets(ioWithSockets([socket]), d, log);

    expect(count).toBe(0);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("startSessionSweep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sweeps on the interval and stops when asked", async () => {
    const io = ioWithSockets([]);
    const stop = startSessionSweep(io, deps(), logger(), 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(io.fetchSockets).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(io.fetchSockets).toHaveBeenCalledTimes(3);
  });

  it("does not start another pass while the previous one is still pending", async () => {
    let release!: (sockets: never[]) => void;
    const pending = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    const io = { fetchSockets: vi.fn().mockReturnValue(pending) } as unknown as SocketIOServer;
    const stop = startSessionSweep(io, deps(), logger(), 1_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(io.fetchSockets).toHaveBeenCalledTimes(1);

    release([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(io.fetchSockets).toHaveBeenCalledTimes(2);

    stop();
  });

  it("keeps sweeping after a pass fails", async () => {
    const fetchSockets = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValue([]);
    const io = { fetchSockets } as unknown as SocketIOServer;
    const stop = startSessionSweep(io, deps(), logger(), 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchSockets).toHaveBeenCalledTimes(3);

    stop();
  });
});
