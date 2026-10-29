import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  exec: execMock,
}));

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
const { DomainService } = await import("./service.js");

const PROJECT_ID = "abcdef123456789";
const CONTAINER_PREFIX = "vexlyx-abcdef123456";

const TYPES = [
  { label: "Node.js", type: "NODEJS", buildCmd: "npm run build", port: 3000, service: "app", urlPort: 3000 },
  { label: "Next.js", type: "NEXTJS", buildCmd: "npm run build", port: 3000, service: "app", urlPort: 3000 },
  { label: "Python", type: "PYTHON", buildCmd: null, port: 8000, service: "app", urlPort: 8000 },
  { label: "static", type: "STATIC", buildCmd: null, port: null, service: "app", urlPort: 80 },
  { label: "React", type: "REACT", buildCmd: "npm run build", port: null, service: "app", urlPort: 80 },
  { label: "Docker", type: "DOCKER", buildCmd: null, port: 8080, service: "app", urlPort: 8080 },
  { label: "Nixpacks PHP", type: "PHP", buildCmd: "composer install", port: null, service: "app", urlPort: 80 },
  { label: "no-build PHP", type: "PHP", buildCmd: null, port: null, service: "web", urlPort: 80 },
  { label: "WordPress", type: "WORDPRESS", buildCmd: null, port: null, service: "web", urlPort: 80 },
] as const;

const VARIANTS = [
  { label: "plain, SSL", hostname: "site.example.com", pathPrefix: null, sslEnabled: true },
  { label: "plain, no SSL", hostname: "site.example.com", pathPrefix: null, sslEnabled: false },
  { label: "wildcard, SSL", hostname: "*.example.com", pathPrefix: null, sslEnabled: true },
  { label: "wildcard, no SSL", hostname: "*.example.com", pathPrefix: null, sslEnabled: false },
  { label: "path prefix, SSL", hostname: "site.example.com", pathPrefix: "/blog", sslEnabled: true },
  { label: "path prefix, no SSL", hostname: "site.example.com", pathPrefix: "/blog", sslEnabled: false },
] as const;

function domainFor(
  id: string,
  project: { type: string; buildCmd: string | null; port: number | null },
  variant: { hostname: string; pathPrefix: string | null; sslEnabled: boolean },
) {
  return {
    id,
    userId: "u1",
    status: "ACTIVE",
    certificate: null,
    ...variant,
    project: {
      id: PROJECT_ID,
      name: "Site",
      status: "RUNNING",
      ...project,
    },
  };
}

describe("route upstream", () => {
  let tmp: string;
  let dynamicDir: string;

  const routeFile = (id: string) => path.join(dynamicDir, `domain-${id}.yml`);
  const urlsIn = (id: string) =>
    [...fs.readFileSync(routeFile(id), "utf-8").matchAll(/url: "([^"]+)"/g)].map((m) => m[1]);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vexlyx-upstream-"));
    dynamicDir = path.join(tmp, "docker", "traefik", "dynamic");
    fs.mkdirSync(dynamicDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    execMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("syncTraefikRouter", () => {
    for (const projectCase of TYPES) {
      for (const variant of VARIANTS) {
        it(`${projectCase.label} (${variant.label}) routes to ${projectCase.service}:${projectCase.urlPort}`, () => {
          const service = new DomainService({} as PrismaClient);
          service.syncTraefikRouter(domainFor("d1", projectCase, variant) as never);

          expect(urlsIn("d1")).toEqual([
            `http://${CONTAINER_PREFIX}-${projectCase.service}-1:${projectCase.urlPort}`,
          ]);
        });
      }
    }
  });

  describe("syncAllRoutes (one-time repair of existing route files)", () => {
    const wordpress = { type: "WORDPRESS", buildCmd: null, port: null };
    const node = { type: "NODEJS", buildCmd: "npm run build", port: 3000 };

    function serviceWith(domains: ReturnType<typeof domainFor>[]) {
      const findMany = vi.fn().mockResolvedValue(domains);
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
      const service = new DomainService(
        { domain: { findMany } } as unknown as PrismaClient,
        undefined,
        logger,
      );
      return { service, findMany, logger };
    }

    it("replaces a route file that points at the wrong container", async () => {
      fs.writeFileSync(
        routeFile("d1"),
        `http:\n  services:\n    service-d1:\n      loadBalancer:\n        servers:\n          - url: "http://${CONTAINER_PREFIX}-app-1:80"\n`,
      );
      const { service } = serviceWith([domainFor("d1", wordpress, VARIANTS[0])]);

      const result = await service.syncAllRoutes();

      expect(result).toMatchObject({ written: 1, unchanged: 0, failed: 0 });
      expect(urlsIn("d1")).toEqual([`http://${CONTAINER_PREFIX}-web-1:80`]);
    });

    it("is idempotent: a second run rewrites nothing", async () => {
      const { service } = serviceWith([
        domainFor("d1", wordpress, VARIANTS[0]),
        domainFor("d2", node, VARIANTS[1]),
      ]);

      expect(await service.syncAllRoutes()).toMatchObject({ written: 2, unchanged: 0 });
      const before = fs.statSync(routeFile("d1")).mtimeMs;
      const rename = vi.spyOn(fs, "renameSync");

      expect(await service.syncAllRoutes()).toMatchObject({ written: 0, unchanged: 2, failed: 0 });
      expect(rename).not.toHaveBeenCalled();
      expect(fs.statSync(routeFile("d1")).mtimeMs).toBe(before);
    });

    it("never restarts or signals the proxy", async () => {
      const { service } = serviceWith([domainFor("d1", wordpress, VARIANTS[0])]);
      await service.syncAllRoutes();
      expect(execMock).not.toHaveBeenCalled();
    });

    it("only considers active domains attached to a live project", async () => {
      const { service, findMany } = serviceWith([]);
      await service.syncAllRoutes();

      const where = findMany.mock.calls[0]![0].where;
      expect(where).toMatchObject({
        status: "ACTIVE",
        projectId: { not: null },
        project: { deletedAt: null },
      });
    });

    it("reports a failing domain, logs it and keeps going", async () => {
      const { service, logger } = serviceWith([
        domainFor("d1", wordpress, VARIANTS[0]),
        domainFor("d2", node, VARIANTS[1]),
      ]);
      const realRename = fs.renameSync.bind(fs);
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to).includes("domain-d1")) throw new Error("disk full");
        realRename(from, to);
      });

      const result = await service.syncAllRoutes();

      expect(result).toMatchObject({ written: 1, failed: 1 });
      expect(fs.existsSync(routeFile("d2"))).toBe(true);
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
