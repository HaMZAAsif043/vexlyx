import type { Server as SocketIOServer } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import {
  SubscriptionGate,
  authorizeSocketSubscription,
  type SocketAuthorizer,
} from "../../plugins/socket-auth.js";
import { BACKUPS_ACCESS } from "./access.js";

/**
 * Registers subscribe/unsubscribe handlers for the "backups" room, used to
 * push live backup:progress / backup:completed / restore:progress /
 * restore:completed events (emitted directly by BackupService). The room
 * carries snapshot/item IDs and error messages for every snapshot, so joining
 * it is held to the same guard as the HTTP API (#65).
 */
export function registerBackupSocketHandlers(
  io: SocketIOServer,
  logger: FastifyBaseLogger,
  authorize: SocketAuthorizer,
): void {
  io.on("connection", (socket) => {
    const gate = new SubscriptionGate();

    socket.on("subscribe:backups", async () => {
      const token = gate.begin();
      const allowed = await authorizeSocketSubscription(
        authorize,
        socket,
        BACKUPS_ACCESS,
        "backups:forbidden",
      );
      // Left (or disconnected) while the role lookup was pending: do not join.
      if (!allowed || !gate.isCurrent(token)) return;

      await socket.join("backups");
      logger.debug({ socketId: socket.id }, "Subscribed to backups");
    });

    socket.on("unsubscribe:backups", async () => {
      gate.cancel();
      await socket.leave("backups");
      logger.debug({ socketId: socket.id }, "Unsubscribed from backups");
    });
  });
}
