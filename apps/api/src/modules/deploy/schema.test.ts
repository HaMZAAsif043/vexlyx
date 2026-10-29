import { describe, expect, it } from "vitest";
import { DeployBodySchema } from "./schema.js";

describe("deploy body schema (#192)", () => {
  it.each([
    "x`) || PathPrefix(`/",
    "x`) || HostRegexp(`{any:.*}`)",
    "app.example.com:8080",
    "http://app.example.com",
    "app..example.com",
    "app_example.com",
    "app example.com",
    "app.example.com\nHost(`x`)",
  ])("rejects a domain that can rewrite the Traefik rule: %s", (domain) => {
    expect(DeployBodySchema.safeParse({ domain }).success).toBe(false);
  });

  it.each(["app.example.com", "APP.example.com", "*.example.com", "example.co.uk"])(
    "accepts a plain hostname: %s",
    (domain) => {
      expect(DeployBodySchema.safeParse({ domain }).success).toBe(true);
    },
  );

  it("accepts a deploy without a custom domain", () => {
    expect(DeployBodySchema.safeParse({}).success).toBe(true);
  });
});
