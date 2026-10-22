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

const domain = {
  id: "d1",
  userId: "u1",
  hostname: "example.com",
  status: "ACTIVE",
  sslEnabled: true,
  certificate: null,
  project: {
    id: "abcdef123456789",
    name: "Site",
    status: "RUNNING",
    type: "NODEJS",
    port: 3000,
  },
} as never;

describe("Traefik route files", () => {
  let tmp: string;
  let dynamicDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vexlyx-traefik-"));
    dynamicDir = path.join(tmp, "docker", "traefik", "dynamic");
    fs.mkdirSync(dynamicDir, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    execMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a route without restarting or reloading the proxy", () => {
    const service = new DomainService({} as PrismaClient);
    service.syncTraefikRouter(domain);

    expect(fs.existsSync(path.join(dynamicDir, "domain-d1.yml"))).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("removes a route without restarting or reloading the proxy", () => {
    const service = new DomainService({} as PrismaClient);
    service.syncTraefikRouter(domain);
    service.removeTraefikRouter("d1");

    expect(fs.existsSync(path.join(dynamicDir, "domain-d1.yml"))).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("leaves no temporary files behind in the watched directory", () => {
    const service = new DomainService({} as PrismaClient);
    service.syncTraefikRouter(domain);
    service.syncTraefikRouter(domain);

    expect(fs.readdirSync(dynamicDir)).toEqual(["domain-d1.yml"]);
  });

  it("logs a write failure through the injected logger", () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const service = new DomainService({} as PrismaClient, undefined, logger);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    service.syncTraefikRouter(domain);

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
