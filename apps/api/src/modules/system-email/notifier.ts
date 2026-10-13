import type { SystemEmailEvent } from "@vexlyx/shared";
import type { FastifyBaseLogger } from "fastify";
import type { SystemEmailService } from "./service.js";
import type { EmailParams } from "./templates.js";

// ---------------------------------------------------------------------------
// Module-level singleton so any feature service can send a notification with
// one line, without threading a mailer through every constructor. Mirrors
// cleanup/scheduler.ts. Until the API registers the service at startup (and
// in every unit test) these calls are silent no-ops.
// ---------------------------------------------------------------------------

let service: SystemEmailService | null = null;
let logger: Pick<FastifyBaseLogger, "error"> | null = null;

export function registerSystemEmail(
  instance: SystemEmailService,
  instanceLogger: FastifyBaseLogger,
): void {
  service = instance;
  logger = instanceLogger;
}

export function unregisterSystemEmail(instance: SystemEmailService): void {
  if (service !== instance) return;
  service = null;
  logger = null;
}

function logNotificationFailure(
  dispatchLogger: Pick<FastifyBaseLogger, "error">,
  error: unknown,
  event: SystemEmailEvent,
  target: "admins" | "user",
  recipient?: string,
): void {
  dispatchLogger.error(
    {
      err: error,
      event,
      target,
      ...(recipient === undefined ? {} : { recipient }),
    },
    "Failed to dispatch system email notification",
  );
}

export function notifyUser<E extends SystemEmailEvent>(
  event: E,
  to: string,
  params: EmailParams[E],
): void {
  const dispatchService = service;
  const dispatchLogger = logger;
  if (!dispatchService || !dispatchLogger) return;

  void dispatchService.notify(event, to, params).catch((error: unknown) => {
    logNotificationFailure(dispatchLogger, error, event, "user", to);
  });
}

export function notifyAdmins<E extends SystemEmailEvent>(
  event: E,
  params: EmailParams[E],
): void {
  const dispatchService = service;
  const dispatchLogger = logger;
  if (!dispatchService || !dispatchLogger) return;

  void dispatchService.notifyAdmins(event, params).catch((error: unknown) => {
    logNotificationFailure(dispatchLogger, error, event, "admins");
  });
}
