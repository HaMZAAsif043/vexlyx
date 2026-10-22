import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
const { wordpressRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");
const { WordPressService } = await import("./service.js");

afterEach(() => vi.restoreAllMocks());

// 3 MiB ceiling so the suite can prove both directions: an ordinary multi-MB
// theme archive is accepted (#154's regression), and a genuinely oversized
// one is still rejected with 413.
const MULTIPART_LIMIT = 3 * 1024 * 1024;

async function appFixture() {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(multipart, { limits: { fileSize: MULTIPART_LIMIT } });
  app.decorate("prisma", {} as PrismaClient);
  app.decorate("requireAuth", async (request, reply) => {
    if (request.headers.authorization !== "test-session") {
      return reply
        .status(401)
        .send({ error: "Unauthorized", code: "UNAUTHORIZED", details: {} });
    }
    request.userId = "u1";
  });
  await app.register(wordpressRoutes, { prefix: "/api/projects" });
  return app;
}

const authed = { authorization: "test-session" };

/** Builds a multipart/form-data body by hand (no form-data dep needed). */
function multipartPayload(opts: {
  fields?: Record<string, string>;
  file?: { field?: string; filename: string; content: Buffer };
}): { body: Buffer; contentType: string } {
  const boundary = "----vexlyxTestBoundary";
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(opts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  if (opts.file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${opts.file.field ?? "file"}"; filename="${opts.file.filename}"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
    );
    chunks.push(opts.file.content);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("POST /api/projects/:id/wordpress/upload (multipart, #154)", () => {
  it("requires authentication", async () => {
    const app = await appFixture();
    try {
      const { body, contentType } = multipartPayload({
        fields: { assetType: "theme" },
        file: { filename: "t.zip", content: Buffer.from("PK") },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { "content-type": contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("accepts a multi-MB theme archive that base64 JSON could not deliver", async () => {
    const uploadAsset = vi
      .spyOn(WordPressService.prototype, "uploadAsset")
      .mockResolvedValue({
        message: "ok",
        success: true,
        assetType: "theme",
        extractedFiles: 1,
        targetDir: "/tmp",
      });
    const app = await appFixture();
    try {
      // ~2.5 MB — comfortably past the ~0.75 MB ceiling the old base64-JSON
      // endpoint had under Fastify's 1 MiB default body limit.
      const bigZip = Buffer.alloc(2_500_000, 0x41);
      bigZip.write("PK", 0); // zip magic so it looks like an archive

      const { body, contentType } = multipartPayload({
        fields: { assetType: "theme" },
        file: { filename: "my-theme.zip", content: bigZip },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { ...authed, "content-type": contentType },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(uploadAsset).toHaveBeenCalledTimes(1);
      const [userId, projectId, input] = uploadAsset.mock.calls[0]!;
      expect(userId).toBe("u1");
      expect(projectId).toBe("p1");
      expect(input.assetType).toBe("theme");
      expect(input.zipPath).toMatch(/vexlyx-imports[\\/]p1[\\/]/);
      expect(input.zipPath).toMatch(/\.zip$/);
    } finally {
      await app.close();
    }
  });

  it("passes through the asset type field", async () => {
    const uploadAsset = vi
      .spyOn(WordPressService.prototype, "uploadAsset")
      .mockResolvedValue({
        message: "ok",
        success: true,
        assetType: "plugin",
        extractedFiles: 1,
        targetDir: "/tmp",
      });
    const app = await appFixture();
    try {
      const { body, contentType } = multipartPayload({
        fields: { assetType: "plugin" },
        file: { filename: "akismet.zip", content: Buffer.from("PK\x03\x04") },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { ...authed, "content-type": contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(uploadAsset.mock.calls[0]![2].assetType).toBe("plugin");
    } finally {
      await app.close();
    }
  });

  it("rejects a non-zip file part with 400", async () => {
    const uploadAsset = vi.spyOn(WordPressService.prototype, "uploadAsset");
    const app = await appFixture();
    try {
      const { body, contentType } = multipartPayload({
        fields: { assetType: "plugin" },
        file: { filename: "evil.txt", content: Buffer.from("nope") },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { ...authed, "content-type": contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(uploadAsset).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a missing assetType with 400", async () => {
    const uploadAsset = vi.spyOn(WordPressService.prototype, "uploadAsset");
    const app = await appFixture();
    try {
      const { body, contentType } = multipartPayload({
        file: { filename: "a.zip", content: Buffer.from("PK\x03\x04") },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { ...authed, "content-type": contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(uploadAsset).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("still enforces the multipart size ceiling with 413", async () => {
    const uploadAsset = vi.spyOn(WordPressService.prototype, "uploadAsset");
    const app = await appFixture();
    try {
      const oversize = Buffer.alloc(MULTIPART_LIMIT + 512 * 1024, 0x41);
      const { body, contentType } = multipartPayload({
        fields: { assetType: "theme" },
        file: { filename: "huge.zip", content: oversize },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/p1/wordpress/upload",
        headers: { ...authed, "content-type": contentType },
        payload: body,
      });
      expect(response.statusCode).toBe(413);
      expect(uploadAsset).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
