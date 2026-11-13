import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { expect, it } from "vitest";

it("serves Swagger UI and its static assets with the patched dependency chain", async () => {
  const app = Fastify();
  try {
    await app.register(swagger, { openapi: { info: { title: "Test API", version: "1" } } });
    await app.register(swaggerUi, { routePrefix: "/docs" });
    const page = await app.inject({ url: "/docs/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("swagger-ui");
    const asset = await app.inject({ url: "/docs/static/swagger-ui.css" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/css");
    expect(asset.body).toContain(".swagger-ui");
  } finally {
    await app.close();
  }
});
