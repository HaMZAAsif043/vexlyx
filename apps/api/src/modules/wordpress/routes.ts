import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs/promises";
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

/** Discards a stream without collecting its contents in memory. */
async function drainStream(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
    stream.resume();
  });
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
      const { id } = ProjectIdParamSchema.parse(request.params);
      // Every archive this request put on disk, so the finally block below
      // can remove it no matter how the request exits.
      const tempPaths: string[] = [];

      try {
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
              // saveTempUpload generates the unique, sanitized on-disk name;
              // the client filename is only carried through for readability.
              zipPath = await service.saveTempUpload(
                id,
                part.file,
                part.filename,
                request.log,
              );
              tempPaths.push(zipPath);
            } else {
              // Drain rejected files without buffering them — a single file
              // may be as large as FILE_UPLOAD_MAX_MB (1 GiB by default).
              await drainStream(part.file);
            }
          }
        }

        const body = WordPressUploadSchema.parse({ assetType, zipPath });
        const result = await service.uploadAsset(request.userId!, id, body);
        reply.status(200);
        return result;
      } catch (err) {
        handleWordPressError(err, reply);
      } finally {
        // The archive is only needed while uploadAsset streams it into the
        // extractor. Remove it on EVERY exit path — schema rejection, failed
        // ownership checks, extraction errors — so repeated rejected uploads
        // cannot accumulate on the host disk.
        await Promise.all(
          tempPaths.map((p) =>
            fs.rm(p, { force: true }).catch((err: unknown) => {
              request.log.error(
                { err, path: p },
                "failed to remove temporary WordPress upload",
              );
            }),
          ),
        );
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
            tarPath = await service.saveTempUpload(
              id,
              part.file,
              part.filename,
              request.log,
            );
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
