import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { encrypt, decrypt } = await import("./encryption.js");

describe("encrypt / decrypt", () => {
  it("round-trips a value", () => {
    expect(decrypt(encrypt("s3cret-value"))).toBe("s3cret-value");
  });

  it("round-trips an empty value (an intentionally empty env var)", () => {
    const cipher = encrypt("");

    expect(cipher.split(":")).toHaveLength(3);
    expect(cipher.split(":")[2]).toBe("");
    expect(decrypt(cipher)).toBe("");
  });

  it("round-trips multi-byte text", () => {
    expect(decrypt(encrypt("pässwörd-密码-🔑"))).toBe("pässwörd-密码-🔑");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects a tampered ciphertext", () => {
    const [iv, tag, data] = encrypt("abcdef").split(":") as [string, string, string];
    const flipped = data.replace(/.$/, data.endsWith("0") ? "1" : "0");

    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it("still authenticates an empty ciphertext: a wrong tag is rejected", () => {
    const [iv, , data] = encrypt("").split(":") as [string, string, string];

    expect(() => decrypt(`${iv}:${"00".repeat(16)}:${data}`)).toThrow();
  });

  it.each([
    ["no parts", "garbage"],
    ["too few parts", "aa:bb"],
    ["empty IV", `:${"00".repeat(16)}:abcd`],
    ["empty tag", `${"00".repeat(12)}::abcd`],
  ])("rejects malformed input: %s", (_label, input) => {
    expect(() => decrypt(input)).toThrow();
  });
});
