import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "./securityHeaders";

function headerValue(isProduction: boolean, apiUrl = "https://api.panel.example.com", key = "Content-Security-Policy") {
  return buildSecurityHeaders({ apiUrl, isProduction }).find((h) => h.key === key)?.value;
}

describe("buildSecurityHeaders", () => {
  it("forbids framing and embedding by other sites", () => {
    const csp = headerValue(true);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headerValue(true, undefined, "X-Frame-Options")).toBe("DENY");
  });

  it("allows connections only to self and the API origin, over http and ws", () => {
    const csp = headerValue(true, "https://api.panel.example.com/some/path");
    expect(csp).toContain("connect-src 'self' https://api.panel.example.com wss://api.panel.example.com;");
    expect(csp).not.toContain("some/path");
  });

  it("lets the GitHub App manifest form post to github.com and return to the API", () => {
    const csp = headerValue(true, "https://api.panel.example.com");
    expect(csp).toContain("form-action 'self' https://github.com https://api.panel.example.com;");
  });

  it("sends unsafe-eval and HSTS only outside production", () => {
    expect(headerValue(false, "http://localhost:5000")).toContain("'unsafe-eval'");
    expect(headerValue(true)).not.toContain("unsafe-eval");
    expect(headerValue(false, "http://localhost:5000", "Strict-Transport-Security")).toBeUndefined();
    expect(headerValue(true, undefined, "Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("sets the baseline hardening headers", () => {
    expect(headerValue(true, undefined, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(true, undefined, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("throws on a malformed API URL so a bad build arg fails loudly", () => {
    expect(() => buildSecurityHeaders({ apiUrl: "not-a-url", isProduction: true })).toThrow();
  });
});
