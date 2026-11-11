import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";

const { MailService, MailError } = await import("./service.js");
const { DomainError } = await import("../domains/service.js");
const { mailRoutes } = await import("./routes.js");

afterEach(() => vi.restoreAllMocks());

describe("mail error response contract", () => {
  it.each([
    {
      failure: new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404),
      details: {},
    },
    {
      failure: new DomainError("Domain unavailable", "DOMAIN_UNAVAILABLE", 503),
      details: {},
    },
    {
      failure: new MailError(
        "Activation failed",
        "MAIL_STATE_ACTIVATION_FAILED",
        503,
        { phase: "prepare" },
      ),
      details: { phase: "prepare" },
    },
  ])(
    "returns required fields for $failure.code",
    async ({ failure, details }) => {
      const operation = vi
        .spyOn(MailService.prototype, "ensureEmailAuthRecords")
        .mockRejectedValue(failure);
      const app = Fastify();
      app.decorate("prisma", {} as PrismaClient);
      app.decorate("requireAuth", async (request, reply) => {
        if (request.headers.authorization !== "test-session") {
          return reply
            .status(401)
            .send({ error: "Unauthorized", code: "UNAUTHORIZED", details: {} });
        }
        request.userId = "u1";
      });
      app.decorate("requireRole", () => app.requireAuth);
      await app.register(mailRoutes, { prefix: "/api/mail" });
      try {
        const unauthorized = await app.inject({
          method: "POST",
          url: "/api/mail/auth/domain1/regenerate",
        });
        expect(unauthorized.statusCode).toBe(401);
        expect(operation).not.toHaveBeenCalled();
        const response = await app.inject({
          method: "POST",
          url: "/api/mail/auth/domain1/regenerate",
          headers: { authorization: "test-session" },
        });
        expect(response.statusCode).toBe(failure.statusCode);
        expect(response.json()).toEqual({
          error: failure.message,
          code: failure.code,
          details,
        });
      } finally {
        await app.close();
      }
    },
  );
});

describe("test email body validation (#194)", () => {
  it("rejects a subject with line breaks before reaching the helper", async () => {
    const send = vi.spyOn(MailService.prototype, "sendTestEmail");
    const app = Fastify();
    app.decorate("prisma", {} as PrismaClient);
    app.decorate("requireAuth", async (request) => {
      request.userId = "u1";
    });
    app.decorate("requireRole", () => app.requireAuth);
    await app.register(mailRoutes, { prefix: "/api/mail" });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mail/test-send",
        payload: {
          from: "no-reply@one.example",
          to: "someone@example.net",
          subject: "Hi\r\nBcc: victim@example.net",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
