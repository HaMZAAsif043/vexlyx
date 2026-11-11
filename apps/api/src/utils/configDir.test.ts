import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configDir } from "./configDir.js";
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/test";
  process.env.SESSION_SECRET ??=
    "test-session-secret-at-least-32-characters-long";
});
import { DomainService } from "../modules/domains/service.js";
let temp: string;
let cwd: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "vexlyx-config-"));
  cwd = path.join(temp, "repo/apps/api");
  fs.mkdirSync(cwd, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
it.each(["coredns/zones", "traefik/dynamic"] as const)(
  "creates the canonical fallback for %s",
  (name) => {
    const expected = path.resolve(cwd, "../../docker", name);
    expect(configDir(name)).toBe(expected);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  },
);
it("deletes only the zone in the directory used by DNS operations", async () => {
  const primary = path.join(cwd, "docker/coredns/zones");
  const secondary = path.resolve(cwd, "../../docker/coredns/zones");
  for (const dir of [primary, secondary]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "example.test.db"), "zone");
  }
  const service = new DomainService({
    domain: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: "d1", hostname: "example.test" }),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    },
  } as never);
  vi.spyOn(service, "removeTraefikRouter").mockImplementation(() => {});
  expect(configDir("coredns/zones")).toBe(primary);
  await service.delete("u1", "d1");
  expect(fs.existsSync(path.join(primary, "example.test.db"))).toBe(false);
  expect(fs.readFileSync(path.join(secondary, "example.test.db"), "utf8")).toBe(
    "zone",
  );
});
