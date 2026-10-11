import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema } from "fastify";
import fp from "fastify-plugin";

const tagNames: Record<string, string> = {
  aliases: "Email aliases",
  auth: "Authentication",
  "audit-log": "Audit log",
  backups: "Backups",
  cleanup: "Cleanup",
  dashboard: "Dashboard",
  databases: "Databases",
  domains: "Domains and DNS",
  files: "Files",
  firewall: "Firewall",
  github: "GitHub",
  health: "Health",
  mail: "Mail operations",
  mailboxes: "Mailboxes",
  monitoring: "Monitoring",
  projects: "Projects",
  services: "Services",
  sftp: "SFTP",
  system: "System",
  "system-email": "System email",
  users: "Users",
  webhooks: "Webhooks",
};

const errorSchema = {
  type: "object",
  required: ["error", "code", "details"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
} as const;

const publicPaths = new Set([
  "/api/health",
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/config",
  "/api/auth/2fa/challenge",
]);

function endpointMetadata(method: string, url: string, schema: FastifySchema | undefined) {
  const routePath = url.replace(/^\/api\//, "");
  const resource = routePath.split("/")[0] ?? "system";
  const normalizedMethod = method.toLowerCase();
  const operationPath = routePath
    .replace(/:([A-Za-z0-9_]+)/g, "by-$1")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const existingResponses =
    schema?.response && typeof schema.response === "object" ? schema.response : {};

  return {
    ...schema,
    operationId: schema?.operationId ?? `${normalizedMethod}-${operationPath || "root"}`,
    summary:
      schema?.summary ??
      `${normalizedMethod.toUpperCase()} ${url.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`,
    tags: schema?.tags ?? [tagNames[resource] ?? resource],
    security:
      schema?.security ??
      (publicPaths.has(url) || url.startsWith("/api/webhooks/")
        ? []
        : [{ sessionCookie: [] }]),
    response: {
      400: { description: "Invalid request", ...errorSchema },
      401: { description: "Authentication required", ...errorSchema },
      403: { description: "Insufficient permission", ...errorSchema },
      404: { description: "Resource not found", ...errorSchema },
      ...existingResponses,
    },
  } satisfies FastifySchema;
}

async function registerOpenApi(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Vexlyx API",
        description:
          "HTTP API for the Vexlyx hybrid hosting control panel. Most operations authenticate with the vexlyx_session cookie.",
        version: "0.0.1",
        license: {
          name: "MIT",
          identifier: "MIT",
        },
      },
      servers: [{ url: "/", description: "Current Vexlyx installation" }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "vexlyx_session",
          },
        },
      },
      security: [{ sessionCookie: [] }],
      tags: Object.entries(tagNames).map(([name, description]) => ({
        name: description,
        description: `${description} endpoints under /api/${name}.`,
      })),
    },
  });

  app.addHook("onRoute", (routeOptions) => {
    if (routeOptions.url.startsWith("/documentation")) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const method = String(methods[0] ?? "GET");
    routeOptions.schema = endpointMetadata(method, routeOptions.url, routeOptions.schema);
  });

  await app.register(swaggerUi, {
    routePrefix: "/documentation",
    uiConfig: {
      deepLinking: true,
      displayOperationId: true,
      docExpansion: "list",
      filter: true,
      persistAuthorization: false,
    },
    staticCSP: true,
  });
}

export const openApiPlugin = fp(registerOpenApi, {
  name: "openapi",
});
