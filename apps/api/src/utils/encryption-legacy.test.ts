import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
const DEDICATED_KEY = "dedicated-encryption-key-at-least-32-characters-long";

async function loadEncryption(overrides: Record<string, string | undefined>) {
  const nextEnv: NodeJS.ProcessEnv = {
    ...originalEnv,
    DATABASE_URL: "postgresql://vexlyx:test@localhost:5432/vexlyx_test",
    SESSION_SECRET,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete nextEnv[key];
    else nextEnv[key] = value;
  }
  process.env = nextEnv;
  vi.resetModules();
  return import("./encryption.js");
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("legacy SESSION_SECRET-derived key (#69)", () => {
  it("does not read old data once ENCRYPTION_KEY is set without the fallback flag", async () => {
    const legacy = await loadEncryption({ ENCRYPTION_KEY: undefined });
    const oldCipher = legacy.encrypt("github-private-key");

    const upgraded = await loadEncryption({ ENCRYPTION_KEY: DEDICATED_KEY });

    expect(() => upgraded.decrypt(oldCipher)).toThrow();
  });

  it("reads old data and flags it for re-encryption when the fallback is on", async () => {
    const legacy = await loadEncryption({ ENCRYPTION_KEY: undefined });
    const oldCipher = legacy.encrypt("github-private-key");

    const upgraded = await loadEncryption({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });

    expect(upgraded.decryptWithMeta(oldCipher)).toEqual({
      plainText: "github-private-key",
      legacy: true,
    });
    const fresh = upgraded.encrypt("github-private-key");
    expect(upgraded.decryptWithMeta(fresh)).toEqual({
      plainText: "github-private-key",
      legacy: false,
    });
  });

  it("new writes are no longer readable with SESSION_SECRET alone", async () => {
    const upgraded = await loadEncryption({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const fresh = upgraded.encrypt("secret");

    const legacy = await loadEncryption({ ENCRYPTION_KEY: undefined });

    expect(() => legacy.decrypt(fresh)).toThrow();
  });

  it("still rejects tampered data with the fallback on", async () => {
    const upgraded = await loadEncryption({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const [iv, tag, data] = upgraded.encrypt("abcdef").split(":") as [string, string, string];
    const flipped = data.replace(/.$/, data.endsWith("0") ? "1" : "0");

    expect(() => upgraded.decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it("warns at boot when running without a dedicated key or on the fallback", async () => {
    const none = await loadEncryption({ ENCRYPTION_KEY: undefined });
    expect(none.getEncryptionKeyWarnings()).toHaveLength(1);

    const fallback = await loadEncryption({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    expect(fallback.getEncryptionKeyWarnings()).toHaveLength(1);

    const clean = await loadEncryption({ ENCRYPTION_KEY: DEDICATED_KEY });
    expect(clean.getEncryptionKeyWarnings()).toEqual([]);
  });
});
