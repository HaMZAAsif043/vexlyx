import { describe, expect, it, vi } from "vitest";
import {
  createSocketOriginHandler,
  isSocketOriginAllowed,
} from "./socket-origin.js";

const configuredOrigin = "https://panel.example.com";

function productionPolicy(origin = configuredOrigin) {
  return { configuredOrigin: origin, nodeEnvironment: "production" as const };
}

describe("Socket.IO origin policy", () => {
  it("allows the configured origin in production", () => {
    expect(isSocketOriginAllowed(configuredOrigin, productionPolicy())).toBe(
      true,
    );
  });

  it("compares normalized origins", () => {
    expect(
      isSocketOriginAllowed(
        "https://PANEL.EXAMPLE.COM:443",
        productionPolicy("https://panel.example.com/"),
      ),
    ).toBe(true);
  });

  it("rejects an arbitrary external origin in production", () => {
    expect(
      isSocketOriginAllowed("https://attacker.example", productionPolicy()),
    ).toBe(false);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "rejects an unconfigured loopback origin in production: %s",
    (origin) => {
      expect(isSocketOriginAllowed(origin, productionPolicy())).toBe(false);
    },
  );

  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "allows a loopback origin in production when it is explicitly configured: %s",
    (origin) => {
      expect(isSocketOriginAllowed(origin, productionPolicy(origin))).toBe(
        true,
      );
    },
  );

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://dev.example.test",
  ])("allows valid HTTP origins during development: %s", (origin) => {
    expect(
      isSocketOriginAllowed(origin, {
        configuredOrigin,
        nodeEnvironment: "development",
      }),
    ).toBe(true);
  });

  it.each([
    "not a URL",
    "",
    "https://panel.example.com.attacker.example",
    "https://panel.example.com@attacker.example",
    "https://panel.example.com/path",
    "https://panel.example.com?redirect=https://attacker.example",
    "javascript:alert(1)",
  ])("rejects malformed or deceptive origins safely: %s", (origin) => {
    expect(isSocketOriginAllowed(origin, productionPolicy())).toBe(false);
  });

  it("allows a missing Origin header for authenticated non-browser clients", () => {
    expect(isSocketOriginAllowed(undefined, productionPolicy())).toBe(true);
  });

  it("returns ORIGIN_NOT_ALLOWED through the Socket.IO CORS callback", () => {
    const callback = vi.fn();
    createSocketOriginHandler(productionPolicy())(
      "https://attacker.example",
      callback,
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(new Error("ORIGIN_NOT_ALLOWED"));
  });
});
