import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketIOServer } from "socket.io";

/**
 * A Socket.IO connection is authenticated once, at the handshake. Without the
 * helpers below its identity would outlive the session that created it (#64):
 * rooms would keep streaming logs after logout, and a socket kept open across a
 * logout -> login-as-someone-else in the same tab would act as the old user.
 *
 * Each socket joins a room per session and per user, so an auth change can
 * target exactly the sockets it affects with `io.in(room).disconnectSockets()`.
 */
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

/** Closes every socket that was opened with this session. */
export function disconnectSessionSockets(io: SocketIOServer | null, sessionId: string): void {
  io?.in(sessionRoom(sessionId)).disconnectSockets(true);
}

/** Closes every socket of a user (all sessions), e.g. when the account is deleted. */
export function disconnectUserSockets(io: SocketIOServer | null, userId: string): void {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

export interface SessionSweepDeps {
  /** True while the session still exists, is unexpired, and belongs to `userId`. */
  isSessionValid(sessionId: string, userId: string): Promise<boolean>;
  /** Of the given user ids, the ones that still exist. */
  existingUserIds(userIds: string[]): Promise<Set<string>>;
}

/**
 * One pass over every connected socket: disconnects the ones whose session has
 * ended (expired, destroyed elsewhere) or whose user no longer exists.
 *
 * Destroy hooks cover explicit logout and password changes immediately; this
 * sweep is the backstop for everything that has no hook, most importantly the
 * silent 24h session expiry. Fails open for the pass on infrastructure errors
 * (a Redis/DB blip must not mass-disconnect every user); the next pass retries.
 *
 * @returns how many sockets were disconnected
 */
export async function sweepInvalidSockets(
  io: SocketIOServer,
  deps: SessionSweepDeps,
  logger: Pick<FastifyBaseLogger, "error" | "debug">,
): Promise<number> {
  try {
    const sockets = await io.fetchSockets();
    if (sockets.length === 0) return 0;

    const userIds = [
      ...new Set(
        sockets
          .map((s) => s.data.userId as string | undefined)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const existing = await deps.existingUserIds(userIds);

    let disconnected = 0;
    for (const socket of sockets) {
      const userId = socket.data.userId as string | undefined;
      const sessionId = socket.data.sessionId as string | undefined;

      const valid =
        !!userId &&
        !!sessionId &&
        existing.has(userId) &&
        (await deps.isSessionValid(sessionId, userId));

      if (!valid) {
        socket.disconnect(true);
        disconnected += 1;
      }
    }

    if (disconnected > 0) {
      logger.debug({ disconnected }, "Disconnected sockets with ended sessions");
    }
    return disconnected;
  } catch (err) {
    logger.error({ err }, "Socket session sweep failed; will retry on the next pass");
    return 0;
  }
}

/**
 * Runs {@link sweepInvalidSockets} on an interval. Returns a function that stops it.
 *
 * Passes never overlap: if the previous pass is still pending (e.g. Redis is
 * unreachable and its client retries indefinitely), the tick is skipped, so a
 * long outage holds at most one unfinished pass instead of accumulating one
 * per interval.
 */
export function startSessionSweep(
  io: SocketIOServer,
  deps: SessionSweepDeps,
  logger: Pick<FastifyBaseLogger, "error" | "debug">,
  intervalMs = 60_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      logger.debug({}, "Skipping socket session sweep: previous pass still running");
      return;
    }
    running = true;
    void sweepInvalidSockets(io, deps, logger).finally(() => {
      running = false;
    });
  }, intervalMs);
  // Never keep the process alive just for the sweep.
  timer.unref?.();
  return () => clearInterval(timer);
}
