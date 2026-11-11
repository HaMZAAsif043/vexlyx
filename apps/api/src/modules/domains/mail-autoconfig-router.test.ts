import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
  process.env.SESSION_SECRET ??=
    "test-session-secret-at-least-32-characters-long";
});
vi.mock("../../config/env.js", () => ({
  env: { HOSTED_MAIL_HOSTNAME: "mx.provider.test" },
}));
import { DomainService } from "./service.js";
let temp: string;
let directory: string;
const domain = {
  id: "d1",
  hostname: "example.test",
  parentId: null,
  status: "ACTIVE",
  sslEnabled: true,
  certificate: null,
  project: null,
};
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "vexlyx-autoconfig-"));
  directory = path.join(temp, "docker/traefik/dynamic");
  fs.mkdirSync(directory, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(temp);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
const file = () => path.join(directory, "mail-autoconfig-d1.yml");
it("routes only the standard discovery path for a mail-only domain, with HTTPS", () => {
  const service = new DomainService({} as never);
  service.syncTraefikRouter(domain as never);
  const config = fs.readFileSync(file(), "utf8");
  expect(config).toContain(
    "Host(`example.test`) && Path(`/.well-known/autoconfig/mail/config-v1.1.xml`)",
  );
  expect(config).toContain('url: "http://vexlyx-api:5000"');
  expect(config).toContain("priority: 1000");
  expect(config).toContain("certResolver: letsencrypt");
  expect(config).toContain("redirectScheme: { scheme: https");
  expect(fs.existsSync(path.join(directory, "domain-d1.yml"))).toBe(false);
});
it.each([
  { status: "PENDING" },
  { parentId: "root" },
  { hostname: "*.example.test" },
  { sslEnabled: false },
])("removes stale discovery when no longer eligible: %j", (override) => {
  const service = new DomainService({} as never);
  service.syncTraefikRouter(domain as never);
  service.syncTraefikRouter({ ...domain, ...override } as never);
  expect(fs.existsSync(file())).toBe(false);
});
it("loads existing custom certificate files without requesting ACME", () => {
  new DomainService({} as never).syncTraefikRouter({
    ...domain,
    certificate: { type: "CUSTOM" },
  } as never);
  const config = fs.readFileSync(file(), "utf8");
  expect(config).toContain("certFile: /etc/traefik/certs/domain-d1.crt");
  expect(config).not.toContain("certResolver");
});
it("keeps discovery on project detach and removes it on domain deletion", () => {
  const service = new DomainService({} as never);
  service.syncTraefikRouter(domain as never);
  service.removeTraefikRouter("d1", false);
  expect(fs.existsSync(file())).toBe(true);
  service.removeTraefikRouter("d1");
  expect(fs.existsSync(file())).toBe(false);
});
it("repairs mail-only routes at startup and does not rewrite unchanged files", async () => {
  const service = new DomainService({
    domain: { findMany: vi.fn().mockResolvedValue([domain]) },
  } as never);
  expect(await service.syncAllRoutes()).toMatchObject({
    written: 1,
    failed: 0,
  });
  const rename = vi.spyOn(fs, "renameSync");
  expect(await service.syncAllRoutes()).toMatchObject({
    unchanged: 1,
    failed: 0,
  });
  expect(rename).not.toHaveBeenCalled();
});

it("coexists with a project's route without changing its upstream", () => {
  const service = new DomainService({} as never);
  service.syncTraefikRouter({
    ...domain,
    project: {
      id: "abcdef123456789",
      name: "Site",
      type: "NODEJS",
      status: "RUNNING",
      port: 3000,
      buildCmd: "npm run build",
    },
  } as never);
  expect(fs.readFileSync(file(), "utf8")).toContain("http://vexlyx-api:5000");
  const projectRoute = fs.readFileSync(
    path.join(directory, "domain-d1.yml"),
    "utf8",
  );
  expect(projectRoute).toContain("http://vexlyx-abcdef123456-app-1:3000");
  expect(projectRoute).not.toContain("vexlyx-api");
});
it("does not regenerate a deleted project's upstream for a mail root", async () => {
  const service = new DomainService({
    domain: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ ...domain, project: { deletedAt: new Date() } }]),
    },
  } as never);
  expect(await service.syncAllRoutes()).toMatchObject({
    written: 1,
    failed: 0,
  });
  expect(fs.existsSync(file())).toBe(true);
  expect(fs.existsSync(path.join(directory, "domain-d1.yml"))).toBe(false);
});
