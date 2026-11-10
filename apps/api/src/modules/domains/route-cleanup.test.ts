import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { removeTraefikRouteFile } = await import("./service.js");
afterEach(() => vi.restoreAllMocks());

describe("retryable route cleanup", () => {
  it("reports filesystem failures rather than allowing domain detachment", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    expect(() => removeTraefikRouteFile("d1")).toThrow(
      expect.objectContaining({ code: "DOMAIN_ROUTE_CLEANUP_FAILED", statusCode: 503 }),
    );
  });
  it("treats a route concurrently removed by another cleanup as success", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() => removeTraefikRouteFile("d1")).not.toThrow();
  });
});
