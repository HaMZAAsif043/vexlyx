import type { FastifyInstance } from "fastify";
import { createQueue, createWorker } from "../../config/queue.js";
import { AuditLogService } from "../audit-log/service.js";
import { SystemEmailTestSchema } from "./schema.js";
import { SYSTEM_EMAIL_QUEUE, SystemEmailService, type SystemEmailJob } from "./service.js";
import { registerSystemEmail, unregisterSystemEmail } from "./notifier.js";

export async function systemEmailRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);

  const queue = createQueue(SYSTEM_EMAIL_QUEUE);
  const service = new SystemEmailService(queue, app.redis, app.prisma, app.log);
  const worker = createWorker<SystemEmailJob>(SYSTEM_EMAIL_QUEUE, (job) => service.deliver(job.data), app, {
    concurrency: 2,
  });

  app.registerQueue(queue, worker);
  registerSystemEmail(service, app.log);
  app.addHook("onClose", async () => unregisterSystemEmail(service));
  void service.ensureSenderIdentity();

  // GET /api/system-email/status
  app.get("/status", { preHandler: [app.requireRole("ADMIN")] }, async () => service.status());

  // POST /api/system-email/test
  app.post("/test", { preHandler: [app.requireRole("ADMIN")] }, async (request, reply) => {
    const { to } = SystemEmailTestSchema.parse(request.body);

    try {
      await service.sendTest(to);
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof Error ? err.message : "Failed to send the test email",
        code: "EMAIL_SEND_FAILED",
        details: {},
      });
    }

    await auditLog.log(request.userId!, "system_email.test_sent", { type: "SystemEmail", id: "system" }, {});
    return { message: "Test email sent" };
  });
}
