import Fastify from "fastify";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { APP_NAME, VEXLYX_VERSION } from "@vexlyx/shared";
import { env } from "./config/env.js";
import { databasePlugin } from "./config/database.js";
import { redisClientPlugin } from "./config/redis.js";
import { queuePlugin_ } from "./config/queue.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { authSessionPlugin } from "./plugins/auth.js";
import { socketPlugin } from "./plugins/socket.js";
import { openApiPlugin } from "./plugins/openapi.js";
import { healthRoutes } from "./modules/health/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { gitRoutes } from "./modules/git/routes.js";
import { buildRoutes } from "./modules/build/routes.js";
import { deployRoutes } from "./modules/deploy/routes.js";
import { logRoutes } from "./modules/logs/routes.js";
import { envRoutes } from "./modules/env/routes.js";
import { wordpressRoutes } from "./modules/wordpress/routes.js";
import { dockerfileRoutes } from "./modules/dockerfile/routes.js";
import { databaseRoutes } from "./modules/databases/routes.js";
import { webhookRoutes } from "./modules/webhooks/routes.js";
import { domainRoutes } from "./modules/domains/routes.js";
import { DnsService, checkDnsZonesDirWritable } from "./modules/domains/dns-service.js";
import { mailRoutes } from "./modules/mail/routes.js";
import { mailboxRoutes } from "./modules/mailboxes/routes.js";
import { aliasRoutes } from "./modules/aliases/routes.js";
import { vacationRoutes } from "./modules/vacation/routes.js";
import { fileRoutes } from "./modules/files/routes.js";
import { sftpRoutes } from "./modules/sftp/routes.js";
import { monitoringRoutes } from "./modules/monitoring/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { backupRoutes } from "./modules/backups/routes.js";
import { cleanupRoutes } from "./modules/cleanup/routes.js";
import { firewallRoutes } from "./modules/firewall/routes.js";
import { servicesRoutes } from "./modules/services/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { auditLogRoutes } from "./modules/audit-log/routes.js";
import { systemRoutes } from "./modules/system/routes.js";
import { systemEmailRoutes } from "./modules/system-email/routes.js";
import { githubRoutes } from "./modules/github/routes.js";
import { checkBackupScriptHealth } from "./modules/backups/service.js";
import { getEncryptionKeyWarnings } from "./utils/encryption.js";


/**
 * Creates and configures the Fastify application instance.
 * Registers all plugins (CORS, error handler) and route modules.
 * @returns Configured Fastify instance ready to listen
 */
async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      // Pretty-print logs in development for readability
      ...(env.NODE_ENV !== "production" && {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(formbody);
  await app.register(multipart, {
    limits: { fileSize: env.FILE_UPLOAD_MAX_MB * 1024 * 1024 },
  });
  await app.register(openApiPlugin);
  await app.register(databasePlugin);
  await app.register(redisClientPlugin);
  await app.register(queuePlugin_);
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  await app.register(socketPlugin);

  await app.register(healthRoutes, { prefix: "/api/health" });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(projectRoutes, { prefix: "/api/projects" });
  await app.register(gitRoutes, { prefix: "/api/projects" });
  await app.register(buildRoutes, { prefix: "/api/projects" });
  await app.register(deployRoutes, { prefix: "/api/projects" });
  await app.register(logRoutes, { prefix: "/api/projects" });
  await app.register(envRoutes, { prefix: "/api/projects" });
  await app.register(wordpressRoutes, { prefix: "/api/projects" });
  await app.register(dockerfileRoutes, { prefix: "/api/projects" });
  await app.register(databaseRoutes, { prefix: "/api/databases" });
  await app.register(webhookRoutes, { prefix: "/api/webhooks" });
  await app.register(domainRoutes, { prefix: "/api/domains" });
  await app.register(mailRoutes, { prefix: "/api/mail" });
  await app.register(mailboxRoutes, { prefix: "/api/mailboxes" });
  await app.register(aliasRoutes, { prefix: "/api/aliases" });
  await app.register(vacationRoutes, { prefix: "/api/mailboxes" });
  await app.register(fileRoutes, { prefix: "/api/files" });
  await app.register(sftpRoutes, { prefix: "/api/sftp" });
  await app.register(monitoringRoutes, { prefix: "/api/monitoring" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboard" });
  await app.register(backupRoutes, { prefix: "/api/backups" });
  await app.register(cleanupRoutes, { prefix: "/api/cleanup" });
  await app.register(firewallRoutes, { prefix: "/api/firewall" });
  await app.register(servicesRoutes, { prefix: "/api/services" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(auditLogRoutes, { prefix: "/api/audit-log" });
  await app.register(systemRoutes, { prefix: "/api/system" });
  await app.register(systemEmailRoutes, { prefix: "/api/system-email" });
  await app.register(githubRoutes, { prefix: "/api/github" });

  return app;
}

/**
 * Starts the Fastify server and sets up graceful shutdown handlers.
 * On SIGINT/SIGTERM, the server finishes in-flight requests before exiting.
 */
async function start() {
  const app = await buildApp();

  // F5.14 — catch a misconfigured Python interpreter/backup_manager.py path
  // loudly at boot rather than silently at the next scheduled backup. Not
  // fatal: the rest of the panel doesn't depend on backups working.
  const backupHealth = await checkBackupScriptHealth();
  if (!backupHealth.ok) {
    app.log.error(
      `Backup system misconfigured: ${backupHealth.error}. Scheduled and manual backups will fail until this is fixed.`,
    );
  }

  // A missing/read-only zones directory would otherwise only show up as a
  // failed write on every DNS record change.
  const zonesDir = checkDnsZonesDirWritable();
  if (!zonesDir.ok) {
    app.log.error(
      `DNS zones directory ${zonesDir.path} is not writable: ${zonesDir.error}. Hosted DNS changes will not be served until this is fixed.`,
    );
  }

  for (const warning of getEncryptionKeyWarnings()) {
    app.log.warn(warning);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully…`);
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      `${APP_NAME} API v${VEXLYX_VERSION} listening on http://${env.HOST}:${env.PORT}`,
    );

    // Zone files are derived from the database, so rebuild them on boot: picks up
    // generator fixes and restores zones if the zones volume was ever lost.
    new DnsService(app.prisma, app.log)
      .syncAllManagedZones()
      .then((count) => app.log.info(`Synced ${count} hosted DNS zone(s)`))
      .catch((err: unknown) => app.log.error(err, "Failed to sync hosted DNS zones"));
  } catch (err) {
    app.log.error(err, "Failed to start server");
    process.exit(1);
  }
}

void start();
