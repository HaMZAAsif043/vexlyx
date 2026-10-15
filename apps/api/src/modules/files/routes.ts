import type { FastifyInstance, FastifyReply } from "fastify";
import { env } from "../../config/env.js";
import { AuditLogService } from "../audit-log/service.js";
import { FileService, FileError } from "./service.js";
import {
  ProjectIdParamSchema,
  ListQuerySchema,
  ReadQuerySchema,
  CreateBodySchema,
  WriteBodySchema,
  DeleteBodySchema,
  RenameBodySchema,
  MkdirBodySchema,
  CopyBodySchema,
  MoveBodySchema,
  ChmodBodySchema,
  ExtractBodySchema,
  CompressBodySchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleFileError(err: unknown, reply: FastifyReply): void {
  if (err instanceof FileError) {
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
// Routes — mounted under /api/files
// ---------------------------------------------------------------------------

export async function fileRoutes(app: FastifyInstance) {
  const service = new FileService(app.prisma, new AuditLogService(app.prisma, app.log));

  // ── GET /api/files/:id/list ──────────────────────────────────────────
  app.get(
    "/:id/list",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path, depth } = ListQuerySchema.parse(request.query);
        const nodes = await service.listDir(request.userId!, id, path, depth);
        return { nodes };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── GET /api/files/:id/read ──────────────────────────────────────────
  app.get(
    "/:id/read",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path } = ReadQuerySchema.parse(request.query);
        const content = await service.readFile(request.userId!, id, path);
        return { content };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/create ───────────────────────────────────────
  app.post(
    "/:id/create",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path, content } = CreateBodySchema.parse(request.body);
        await service.createFile(request.userId!, id, path, content);
        reply.status(201);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/write ────────────────────────────────────────
  app.post(
    "/:id/write",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path, content, createOnly } = WriteBodySchema.parse(request.body);
        await service.writeFile(request.userId!, id, path, content, createOnly);
        reply.status(200);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── DELETE /api/files/:id/delete ─────────────────────────────────────
  app.delete(
    "/:id/delete",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path } = DeleteBodySchema.parse(request.body);
        await service.deleteNode(request.userId!, id, path);
        reply.status(200);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/rename ───────────────────────────────────────
  app.post(
    "/:id/rename",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { from, to } = RenameBodySchema.parse(request.body);
        await service.rename(request.userId!, id, from, to);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/mkdir ────────────────────────────────────────
  app.post(
    "/:id/mkdir",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path } = MkdirBodySchema.parse(request.body);
        await service.mkdir(request.userId!, id, path);
        reply.status(201);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/copy ─────────────────────────────────────────
  app.post(
    "/:id/copy",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { from, to } = CopyBodySchema.parse(request.body);
        await service.copy(request.userId!, id, from, to);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/move ─────────────────────────────────────────
  app.post(
    "/:id/move",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { from, to } = MoveBodySchema.parse(request.body);
        await service.move(request.userId!, id, from, to);
        return { success: true };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/chmod ────────────────────────────────────────
  app.post(
    "/:id/chmod",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path, mode, recursive, fileMode } = ChmodBodySchema.parse(request.body);
        const { changed } = await service.chmod(request.userId!, id, path, mode, recursive, fileMode);
        return { success: true, changed };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/extract ──────────────────────────────────────
  app.post(
    "/:id/extract",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path, destination, overwrite } = ExtractBodySchema.parse(request.body);
        const result = await service.extract(request.userId!, id, path, destination, overwrite);
        return { success: true, ...result };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/compress ─────────────────────────────────────
  app.post(
    "/:id/compress",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { paths, destination } = CompressBodySchema.parse(request.body);
        const result = await service.compress(request.userId!, id, paths, destination);
        reply.status(201);
        return { success: true, ...result };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── GET /api/files/:id/download ──────────────────────────────────────
  app.get(
    "/:id/download",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { path } = ReadQuerySchema.parse(request.query);
        const { stream, filename, size } = await service.getDownloadStream(
          request.userId!,
          id,
          path,
        );
        reply
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("Content-Type", "application/octet-stream")
          .header("Content-Length", size.toString());
        return reply.send(stream);
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );

  // ── POST /api/files/:id/upload ───────────────────────────────────────
  // Uses @fastify/multipart — registered globally in index.ts
  app.post(
    "/:id/upload",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);

        // Each part from multipart
        const parts = request.parts({
          limits: { fileSize: env.FILE_UPLOAD_MAX_MB * 1024 * 1024 },
        });

        let destPath: string | undefined;
        const uploads: string[] = [];

        for await (const part of parts) {
          if (part.type === "field" && part.fieldname === "path") {
            destPath = part.value as string;
          } else if (part.type === "file") {
            const targetRelPath = destPath
              ? `${destPath}/${part.filename}`
              : part.filename;
            await service.writeUploadStream(
              request.userId!,
              id,
              targetRelPath,
              part.file,
            );
            uploads.push(targetRelPath);
          }
        }

        reply.status(200);
        return { success: true, uploads };
      } catch (err) {
        handleFileError(err, reply);
      }
    },
  );
}
