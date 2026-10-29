import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveHttpUpstream } from "./upstream.js";

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../system/templates/docker-compose",
);

/**
 * Which compose template each project shape is deployed with. This mirrors
 * pick_template() and the no-build switch in system/python/docker_manager.py;
 * the test below fails if resolveHttpUpstream disagrees with what the
 * template actually exposes through Traefik, so the two cannot drift apart.
 */
const SHAPES = [
  { type: "NODEJS", buildCmd: "npm run build", template: "node.yml" },
  { type: "NEXTJS", buildCmd: "npm run build", template: "next.yml" },
  { type: "PYTHON", buildCmd: null, template: "python.yml" },
  { type: "STATIC", buildCmd: null, template: "static.yml" },
  { type: "REACT", buildCmd: "npm run build", template: "static.yml" },
  { type: "DOCKER", buildCmd: null, template: "docker.yml" },
  { type: "PHP", buildCmd: "composer install", template: "php.yml" },
  { type: "PHP", buildCmd: null, template: "php-no-build.yml" },
  { type: "WORDPRESS", buildCmd: null, template: "wordpress.yml" },
] as const;

/** Name and published port of the service the template labels for Traefik. */
function traefikServiceOf(template: string): { service: string; port: string } {
  const lines = fs
    .readFileSync(path.join(TEMPLATES_DIR, template), "utf-8")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const servicesAt = lines.indexOf("services:");
  let current = "";
  let service = "";
  let port = "";
  for (const line of lines.slice(servicesAt + 1)) {
    if (/^[a-z][a-z-]*:/.test(line)) break;
    const header = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (header) current = header[1]!;
    if (line.includes("traefik.enable=true")) service = current;
    const portLabel = /loadbalancer\.server\.port=(\S+?)"/.exec(line);
    if (portLabel) port = portLabel[1]!;
  }
  return { service, port };
}

describe("resolveHttpUpstream", () => {
  it.each(SHAPES)(
    "targets the service $template exposes through Traefik ($type, buildCmd=$buildCmd)",
    ({ type, buildCmd, template }) => {
      const declared = traefikServiceOf(template);
      const upstream = resolveHttpUpstream({ type, buildCmd, port: 4321 });

      expect(upstream.service).toBe(declared.service);
      expect(upstream.port).toBe(
        declared.port === "{{container_port}}" ? 4321 : Number(declared.port),
      );
    },
  );

  it("uses the framework default port when the project has none", () => {
    expect(resolveHttpUpstream({ type: "PYTHON", port: null }).port).toBe(8000);
    expect(resolveHttpUpstream({ type: "NODEJS", port: null }).port).toBe(3000);
  });

  it("is case-insensitive about the project type", () => {
    expect(resolveHttpUpstream({ type: "wordpress" }).service).toBe("web");
  });

  it("treats an empty build command like a missing one", () => {
    expect(resolveHttpUpstream({ type: "PHP", buildCmd: "" }).service).toBe("web");
  });
});
