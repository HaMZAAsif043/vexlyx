import { describe, expect, it } from "vitest";
import { defaultTestMailSender } from "./test-mail-sender";

describe("test email default sender", () => {
  it("uses a valid address for a verified wildcard domain", () => {
    expect(defaultTestMailSender("test@example.com", [{ hostname: "*.one.example", status: "ACTIVE" }]))
      .toBe("no-reply@one.example");
  });
  it("skips unverified domains", () => {
    expect(defaultTestMailSender("test@pending.example", [
      { hostname: "pending.example", status: "PENDING" },
      { hostname: "error.example", status: "ERROR" },
      { hostname: "active.example", status: "ACTIVE" },
    ])).toBe("no-reply@active.example");
  });
  it("preserves an address under a verified domain", () => {
    expect(defaultTestMailSender("admin@mail.one.example", [{ hostname: "*.one.example", status: "ACTIVE" }]))
      .toBe("admin@mail.one.example");
  });
  it("returns an empty sender when there is no verified domain", () => {
    expect(defaultTestMailSender("test@example.com", [{ hostname: "example.com", status: "PENDING" }]))
      .toBe("");
  });
});
