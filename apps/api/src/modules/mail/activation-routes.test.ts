import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
const { MailError } = await import("./service.js");
const { MailboxService } = await import("../mailboxes/service.js");
const { AliasService } = await import("../aliases/service.js");
const { mailboxRoutes } = await import("../mailboxes/routes.js");
const { aliasRoutes } = await import("../aliases/routes.js");
afterEach(() => vi.restoreAllMocks());

describe("saved changes with failed mail activation", () => {
  it.each(["mailboxes", "aliases"])(
    "returns an actionable failure for %s rather than success",
    async (resource) => {
      const failure = new MailError(
        "postfix prepare failed",
        "MAIL_STATE_ACTIVATION_FAILED",
        503,
        { phase: "prepare", rollbackFailed: [] },
      );
      const operation =
        resource === "mailboxes"
          ? vi.spyOn(MailboxService.prototype, "delete")
          : vi.spyOn(AliasService.prototype, "delete");
      operation.mockRejectedValue(failure);
      const app = Fastify();
      app.decorate("prisma", {} as PrismaClient);
      app.decorate("requireAuth", async (request, reply) => {
        if (request.headers.authorization !== "test-session")
          return reply.status(401).send({ error: "Unauthorized" });
        request.userId = "u1";
      });
      await app.register(
        resource === "mailboxes" ? mailboxRoutes : aliasRoutes,
        { prefix: `/api/${resource}` },
      );
      try {
        const unauthenticated = await app.inject({
          method: "DELETE",
          url: `/api/${resource}/id1`,
        });
        expect(unauthenticated.statusCode).toBe(401);
        expect(operation).not.toHaveBeenCalled();
        const response = await app.inject({
          method: "DELETE",
          url: `/api/${resource}/id1`,
          headers: { authorization: "test-session" },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: "MAIL_STATE_ACTIVATION_FAILED",
          details: {
            databaseChanged: true,
            phase: "prepare",
            rollbackFailed: [],
          },
        });
        expect(response.json().error).toContain("The change was saved");
        expect(response.json().error).toContain("Synchronize");
        expect(operation).toHaveBeenCalledWith("u1", "id1");
      } finally {
        await app.close();
      }
    },
    30_000,
  );
});
