import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { createSocketAuthorizer } from "../../plugins/socket-auth.js";
import { BACKUPS_ACCESS } from "./access.js";
import { registerBackupSocketHandlers } from "./socket.js";

type Handler = () => Promise<void>;

function connect(
  user: { role: string; permissions: string[] } | null,
  userId?: string,
  authorizeOverride?: (userId: string | undefined, rule: unknown) => Promise<boolean>,
) {
  const handlers = new Map<string, Handler>();
  const socket = {
    id: "sock-1",
    data: { userId },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
  };
  let onConnection: (s: typeof socket) => void = () => undefined;
  const io = {
    on: vi.fn((_event: string, cb: typeof onConnection) => {
      onConnection = cb;
    }),
  } as unknown as SocketIOServer;
  const logger = { debug: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue(user) },
  } as unknown as PrismaClient;

  const real = createSocketAuthorizer(prisma, logger);
  const authorize = vi.fn((id: string | undefined, rule: Parameters<typeof real>[1]) =>
    authorizeOverride ? authorizeOverride(id, rule) : real(id, rule),
  );
  registerBackupSocketHandlers(io, logger, authorize);
  onConnection(socket);
  return { socket, handlers, authorize };
}

describe("subscribe:backups authorization (#65)", () => {
  it("is authorized with the rule shared with the HTTP routes", async () => {
    expect(BACKUPS_ACCESS).toEqual({ roles: ["ADMIN"], permission: "canManageBackups" });

    const { handlers, authorize } = connect({ role: "ADMIN", permissions: [] }, "u1");
    await handlers.get("subscribe:backups")!();

    expect(authorize).toHaveBeenCalledWith("u1", BACKUPS_ACCESS);
  });

  it("does not join when the client unsubscribes while the role lookup is pending", async () => {
    let allow!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      allow = resolve;
    });
    const { socket, handlers } = connect({ role: "ADMIN", permissions: [] }, "u1", () => pending);

    const subscribing = handlers.get("subscribe:backups")!();
    await handlers.get("unsubscribe:backups")!();
    allow(true);
    await subscribing;

    expect(socket.join).not.toHaveBeenCalled();
  });

  it("joins again on a fresh subscribe after leaving", async () => {
    const { socket, handlers } = connect({ role: "ADMIN", permissions: [] }, "u1");

    await handlers.get("subscribe:backups")!();
    await handlers.get("unsubscribe:backups")!();
    await handlers.get("subscribe:backups")!();

    expect(socket.join).toHaveBeenCalledTimes(2);
  });

  it("lets an admin join", async () => {
    const { socket, handlers } = connect({ role: "ADMIN", permissions: [] }, "u1");

    await handlers.get("subscribe:backups")!();

    expect(socket.join).toHaveBeenCalledWith("backups");
  });

  it("lets a user with canManageBackups join", async () => {
    const { socket, handlers } = connect({ role: "USER", permissions: ["canManageBackups"] }, "u1");

    await handlers.get("subscribe:backups")!();

    expect(socket.join).toHaveBeenCalledWith("backups");
  });

  it.each(["USER", "RESELLER"])("denies a %s without the permission", async (role) => {
    const { socket, handlers } = connect({ role, permissions: [] }, "u1");

    await handlers.get("subscribe:backups")!();

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "backups:forbidden",
      expect.objectContaining({ code: "FORBIDDEN_ROLE" }),
    );
  });

  it("denies a socket with no resolved identity", async () => {
    const { socket, handlers } = connect({ role: "ADMIN", permissions: [] }, undefined);

    await handlers.get("subscribe:backups")!();

    expect(socket.join).not.toHaveBeenCalled();
  });

  it("denies a user that no longer exists", async () => {
    const { socket, handlers } = connect(null, "u1");

    await handlers.get("subscribe:backups")!();

    expect(socket.join).not.toHaveBeenCalled();
  });
});
