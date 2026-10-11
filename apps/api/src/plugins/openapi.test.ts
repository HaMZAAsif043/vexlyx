import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { openApiPlugin } from "./openapi.js";

describe("OpenAPI documentation", () => {
  it("discovers API routes and exposes the specification", async () => {
    const app = Fastify();
    await app.register(openApiPlugin);
    app.get("/api/health", async () => ({ status: "ok" }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/documentation/json" });
    const specification = response.json();

    expect(response.statusCode).toBe(200);
    expect(specification.openapi).toBe("3.1.0");
    expect(specification.paths["/api/health"].get.operationId).toBe("get-health");
    expect(specification.paths["/api/health"].get.tags).toContain("Health");
    expect(specification.paths["/api/health"].get.security).toEqual([]);

    await app.close();
  });

  it("serves an interactive reference", async () => {
    const app = Fastify();
    await app.register(openApiPlugin);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/documentation/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");

    await app.close();
  });
});
