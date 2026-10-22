import type { FastifyInstance, FastifyReply } from "fastify";
import { basename } from "node:path";
import { WordPressService, WordPressError } from "./service.js";
import {
  ProjectIdParamSchema,
  WordPressInstallSchema,
  WordPressUploadSchema,
  WordPressImportSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleWordPressError(err: unknown, reply: FastifyReply): void {
  if (err instanceof WordPressError) {
    reply.status(err.statusCode).send({
      error: err.message,
      code: err.code,
      details: {},
    });
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Routes -- mounted under /api/projects
// ---------------------------------------------------------------------------

export async function wordpressRoutes(app: FastifyInstance) {
  const service = new WordPressService(app.prisma);

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/wordpress/install
  // 1-Click WordPress installation and configuration
  // -------------------------------------------------------------------------
  app.post(
    "/:id/wordpress/install",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const body = WordPressInstallSchema.parse(request.body ?? {});
        const result = await service.install(request.userId!, id, body);
        reply.status(200);
        return result;
      } catch (err) {
        handleWordPressError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/wordpress/upload
  // Upload and unpack plugin or theme zip (multipart — real theme/plugin
  // archives are routinely multiple MB, which exceeded Fastify's default
  // 1 MiB JSON body limit when this endpoint expected base64 JSON, #154).
  // -------------------------------------------------------------------------
  app.post(
    "/:id/wordpress/upload",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);

        let assetType: string | undefined;
        let zipPath: string | undefined;

        // File-size ceiling comes from the global multipart registration
        // (FILE_UPLOAD_MAX_MB) — same policy as the files module.
        const parts = request.parts();

        for await (const part of parts) {
          if (part.type === "field" && part.fieldname === "assetType") {
            assetType = String(part.value);
          } else if (part.type === "file") {
            if (
              part.fieldname === "file" &&
              part.filename.toLowerCase().endsWith(".zip")
            ) {
              // Never trust the client filename for disk paths: strip any
              // directory components and non-name characters, then prefix a
              // timestamp so concurrent uploads cannot collide.
              const safeName = `${Date.now()}-${basename(part.filename).replace(/[^\w.-]/g, "_")}`;
              zipPath = await service.saveTempUpload(id, part.file, safeName);
            } else {
              // Drain rejected files so the request can complete cleanly.
              await part.toBuffer();
            }
          }
        }

        const body = WordPressUploadSchema.parse({ assetType, zipPath });
        const result = await service.uploadAsset(request.userId!, id, body);
        reply.status(200);
        return result;
      } catch (err) {
        handleWordPressError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/wordpress/status
  // Get WordPress installation status, core version, plugins, themes
  // -------------------------------------------------------------------------
  app.get(
    "/:id/wordpress/status",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const result = await service.getStatus(request.userId!, id);
        return result;
      } catch (err) {
        handleWordPressError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/wordpress/export
  // One-click export: files + DB as tar.gz download
  // -------------------------------------------------------------------------
  app.get(
    "/:id/wordpress/export",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { stream, filename } = await service.exportSite(request.userId!, id);
        reply
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("Content-Type", "application/gzip");
        return reply.send(stream);
      } catch (err) {
        handleWordPressError(err, reply);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/wordpress/import
  // Upload tar.gz → extract → import SQL → update wp-config
  // -------------------------------------------------------------------------
  app.post(
    "/:id/wordpress/import",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);

        let tarPath: string | undefined;
        let databaseId: string | undefined;

        const parts = request.parts({
          limits: { fileSize: 500 * 1024 * 1024 },
        });

        for await (const part of parts) {
          if (part.type === "field") {
            if (part.fieldname === "databaseId") databaseId = part.value as string;
          } else if (part.type === "file" && part.filename.endsWith(".tar.gz")) {
            tarPath = await service.saveTempUpload(id, part.file, part.filename);
          }
        }

        const body = WordPressImportSchema.parse({ tarPath, databaseId });
        const result = await service.importSite(request.userId!, id, body);
        reply.status(200);
        return result;
      } catch (err) {
        handleWordPressError(err, reply);
      }
    },
  );
}
