import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Server as SocketIOServer, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { env } from "../config/env.js";
import {
  disconnectSessionSockets as disconnectSessionSocketsOn,
  disconnectUserSockets as disconnectUserSocketsOn,
  startSessionSweep,
  sessionRoom,
  userRoom,
} from "./socket-session.js";
import {
  createSocketOriginHandler,
  isSocketOriginAllowed,
} from "./socket-origin.js";

// ---------------------------------------------------------------------------
// Module-level singleton so other modules can call getIO() without circular deps
// ---------------------------------------------------------------------------

let _io: SocketIOServer | null = null;

export function getIO(): SocketIOServer {
  if (!_io) throw new Error("Socket.io server not yet initialised");
  return _io;
}

/**
 * Disconnects every socket opened with `sessionId` (logout, session revoked).
 * A no-op before the socket server exists, so auth code can call it freely.
 */
export function disconnectSessionSockets(sessionId: string): void {
  disconnectSessionSocketsOn(_io, sessionId);
}

/** Disconnects every socket of `userId` (account deleted). No-op before init. */
export function disconnectUserSockets(userId: string): void {
  disconnectUserSocketsOn(_io, userId);
}

// ---------------------------------------------------------------------------
// Session resolution (mirrors auth.ts logic)
// ---------------------------------------------------------------------------

interface SessionData {
  userId: string;
  expiresAt: number;
}

const SESSION_COOKIE = "vexlyx_session";

function sessionKey(id: string) {
  return `session:${id}`;
}

function extractSessionId(socket: Socket): string | null {
  const cookieHeader = socket.handshake?.headers?.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const [key, val] = part.trim().split("=");
      if (key?.trim() === SESSION_COOKIE) {
        return decodeURIComponent(val?.trim() ?? "");
      }
    }
  }
  const authSession = socket.handshake?.auth?.sessionId || socket.handshake?.auth?.token;
  if (authSession && typeof authSession === "string") {
    return authSession;
  }
  return null;
}

async function resolveUserId(redis: Redis, sessionId: string): Promise<string | null> {
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;

  try {
    const session: SessionData = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      await redis.del(sessionKey(sessionId));
      return null;
    }
    return session.userId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function initSocketPlugin(app: FastifyInstance) {
  const originPolicy = {
    configuredOrigin: env.CORS_ORIGIN,
    nodeEnvironment: env.NODE_ENV,
  };
  const handleOrigin = createSocketOriginHandler(originPolicy);

  const io = new SocketIOServer(app.server, {
    cors: {
      origin: handleOrigin,
      credentials: true,
    },
    // Browser CORS does not protect WebSocket upgrades, so enforce the same
    // policy at the Engine.IO handshake layer for every transport.
    allowRequest: (request, callback) => {
      callback(null, isSocketOriginAllowed(request.headers.origin, originPolicy));
    },
    transports: ["websocket", "polling"],
  });

  _io = io;

  // Authenticate every incoming connection via session cookie
  io.use(async (socket, next) => {
    const sessionId = extractSessionId(socket);

    if (!sessionId) {
      app.log.warn({ socketId: socket.id }, "Socket connection rejected: No session cookie");
      return next(new Error("UNAUTHORIZED"));
    }

    const userId = await resolveUserId(app.redis, sessionId);
    if (!userId) {
      app.log.warn({ socketId: socket.id }, "Socket connection rejected: Invalid session");
      return next(new Error("UNAUTHORIZED"));
    }

    // Store identity for downstream handlers. The session id is kept so the
    // connection can be tied to — and ended with — the session that opened it.
    socket.data.userId = userId as string;
    socket.data.sessionId = sessionId;
    next();
  });

  io.on("connection", (socket) => {
    app.log.debug({ socketId: socket.id, userId: socket.data.userId as string }, "Socket connected");

    // Rooms used to target this socket when its session or account ends (#64).
    void socket.join([
      sessionRoom(socket.data.sessionId as string),
      userRoom(socket.data.userId as string),
    ]);

    socket.on("disconnect", (reason) => {
      app.log.debug({ socketId: socket.id, reason }, "Socket disconnected");
    });
  });

  // Backstop for session endings that have no hook (the silent 24h expiry) and
  // for deleted users: re-check every live socket once a minute.
  const stopSweep = startSessionSweep(
    io,
    {
      isSessionValid: async (sessionId, userId) =>
        (await resolveUserId(app.redis, sessionId)) === userId,
      existingUserIds: async (userIds) => {
        if (userIds.length === 0) return new Set<string>();
        const rows = await app.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true },
        });
        return new Set(rows.map((row) => row.id));
      },
    },
    app.log,
  );

  // Graceful shutdown: close socket server when Fastify closes
  app.addHook("onClose", async () => {
    stopSweep();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  app.log.info("Socket.io server attached");
}

export const socketPlugin = fp(initSocketPlugin, {
  name: "socket",
  dependencies: ["redis", "prisma"],
});

