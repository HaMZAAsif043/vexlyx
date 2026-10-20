import type { FastifyInstance } from "fastify";
import { SystemService } from "./service.js";
import { UpdateSystemSettingsSchema } from "@vexlyx/shared";
import { rescheduleBackupJob } from "../backups/scheduler.js";
import { rescheduleAllTasks } from "../scheduled-tasks/scheduler.js";

export async function systemRoutes(app: FastifyInstance) {
  const service = new SystemService(app.prisma);

  // GET /api/system/dns-info — public IP + required DNS records (F5.9),
  // surfaced by the Settings page (F5.11) as a post-install reference.
  // ADMIN, or a user granted canManageDns (F5.19).
  app.get(
    "/dns-info",
    { preHandler: [app.requireRoleOrPermission(["ADMIN"], "canManageDns")] },
    async () => {
      return service.getDnsOnboardingInfo();
    },
  );

  // POST /api/system/dns-info/verify — live-checks each record against
  // public resolvers. POST (not GET) since it triggers real outbound DNS
  // queries rather than reading a cached/static value, mirroring
  // domains/:id/dns/:recordId/propagation's same POST-for-live-check convention.
  app.post(
    "/dns-info/verify",
    { preHandler: [app.requireRoleOrPermission(["ADMIN"], "canManageDns")] },
    async () => {
      return service.verifyDnsRecords();
    },
  );

  // GET /api/system/settings — server timezone (F5.13). Any authenticated
  // user can read it, since it governs how timestamps are displayed for
  // everyone, not just admins.
  app.get("/settings", { preHandler: [app.requireAuth] }, async () => {
    return service.getSettings();
  });

  // PUT /api/system/settings — update the server timezone. ADMIN-only since
  // it also changes the wall-clock time the backup cron fires at.
  app.put("/settings", { preHandler: [app.requireRole("ADMIN")] }, async (request) => {
    const { timezone } = UpdateSystemSettingsSchema.parse(request.body);
    const updated = await service.updateSettings(timezone);

    // Re-upsert the backup scheduler immediately so the new timezone takes
    // effect without a restart, mirroring how a scheduleCron edit already
    // re-upserts (backups/routes.ts).
    await rescheduleBackupJob(timezone);

    // Same for every enabled user scheduled task (F5.28) — its BullMQ
    // schedulers carry the same `tz`, and nextRunAt is refreshed alongside.
    await rescheduleAllTasks(app.prisma, timezone, app.log);

    return updated;
  });
}
