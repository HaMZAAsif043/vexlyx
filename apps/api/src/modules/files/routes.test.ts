import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
const { fileRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");
const { FileService, FileError } = await import("./service.js");

afterEach(() => vi.restoreAllMocks());

async function appFixture() {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.decorate("prisma", {} as PrismaClient);
  app.decorate("requireAuth", async (request, reply) => {
    if (request.headers.authorization !== "test-session") {
      return reply
        .status(401)
        .send({ error: "Unauthorized", code: "UNAUTHORIZED", details: {} });
    }
    request.userId = "u1";
  });
  await app.register(fileRoutes, { prefix: "/api/files" });
  return app;
}

const authed = { authorization: "test-session" };

describe.each([
  ["chmod", { path: "a.txt", mode: "644" }],
  ["extract", { path: "a.zip" }],
  ["compress", { paths: ["a.txt"], destination: "a.zip" }],
])("POST /api/files/:id/%s", (action, payload) => {
  it("requires authentication", async () => {
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/files/p1/${action}`,
        payload,
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/files/:id/chmod", () => {
  it("applies the mode as the authenticated user", async () => {
    const chmod = vi
      .spyOn(FileService.prototype, "chmod")
      .mockResolvedValue({ changed: 1 });
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/p1/chmod",
        headers: authed,
        payload: { path: "a.txt", mode: "640" },
      });
      expect(response.statusCode).toBe(200);
      expect(chmod).toHaveBeenCalledWith("u1", "p1", "a.txt", "640", false, undefined);
    } finally {
      await app.close();
    }
  });

  it.each(["777777", "8", "rwx", "4755", ""])("rejects mode %j", async (mode) => {
    const chmod = vi.spyOn(FileService.prototype, "chmod");
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/p1/chmod",
        headers: authed,
        payload: { path: "a.txt", mode },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(chmod).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("archive routes", () => {
  it("maps extraction failures to the standard error shape", async () => {
    vi.spyOn(FileService.prototype, "extract").mockRejectedValue(
      new FileError("Archive contains a link", "UNSAFE_ARCHIVE", 422),
    );
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/p1/extract",
        headers: authed,
        payload: { path: "evil.zip" },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: "Archive contains a link",
        code: "UNSAFE_ARCHIVE",
        details: {},
      });
    } finally {
      await app.close();
    }
  });

  it("returns 403 when the project belongs to someone else", async () => {
    vi.spyOn(FileService.prototype, "compress").mockRejectedValue(
      new FileError("You do not have access to this project", "FORBIDDEN", 403),
    );
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/p1/compress",
        headers: authed,
        payload: { paths: ["a.txt"], destination: "a.zip" },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("requires at least one path to compress", async () => {
    const compress = vi.spyOn(FileService.prototype, "compress");
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/files/p1/compress",
        headers: authed,
        payload: { paths: [], destination: "a.zip" },
      });
      expect(response.statusCode).toBe(400);
      expect(compress).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
