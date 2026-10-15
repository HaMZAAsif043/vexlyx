import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
const DEDICATED_KEY = "dedicated-encryption-key-at-least-32-characters-long";

type Row = Record<string, string | null> & { id: string };

async function load(overrides: Record<string, string | undefined>) {
  process.env = {
    ...originalEnv,
    DATABASE_URL: "postgresql://vexlyx:test@localhost:5432/vexlyx_test",
    SESSION_SECRET,
    ...overrides,
  } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  vi.resetModules();
  const [encryption, reencrypt] = await Promise.all([
    import("./encryption.js"),
    import("./reencryptSecrets.js"),
  ]);
  return { ...encryption, ...reencrypt };
}

/** Minimal in-memory stand-in for the Prisma delegates the script touches. */
function fakePrisma(tables: Record<string, Row[]>) {
  const delegate = (name: string) => ({
    findMany: async () => (tables[name] ?? []).map((row) => ({ ...row })),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, string> }) => {
      const row = (tables[name] ?? []).find((r) => r.id === where.id);
      if (!row) throw new Error(`no ${name} ${where.id}`);
      Object.assign(row, data);
      return row;
    },
  });
  return {
    user: delegate("user"),
    database: delegate("database"),
    certificate: delegate("certificate"),
    envVar: delegate("envVar"),
    sftpUser: delegate("sftpUser"),
    gitHubApp: delegate("gitHubApp"),
  } as unknown as PrismaClient;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("reencryptSecrets (#69)", () => {
  async function legacyFixture() {
    const legacy = await load({ ENCRYPTION_KEY: undefined, ENCRYPTION_KEY_LEGACY_FALLBACK: undefined });
    return {
      envCipher: legacy.encrypt("DB_PASSWORD=hunter2"),
      appKeyCipher: legacy.encrypt("-----BEGIN PRIVATE KEY-----"),
      totpCipher: legacy.encrypt("JBSWY3DPEHPK3PXP"),
    };
  }

  it("moves legacy values to the dedicated key and leaves everything else alone", async () => {
    const { envCipher, appKeyCipher, totpCipher } = await legacyFixture();
    const upgraded = await load({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const alreadyCurrent = upgraded.encrypt("already-new");
    const tables = {
      user: [
        { id: "u1", totpSecretEncrypted: totpCipher },
        { id: "u2", totpSecretEncrypted: null },
      ] as Row[],
      envVar: [
        { id: "e1", value: envCipher },
        { id: "e2", value: alreadyCurrent },
      ] as Row[],
      gitHubApp: [
        {
          id: "singleton",
          encryptedClientSecret: appKeyCipher,
          encryptedPrivateKey: appKeyCipher,
          encryptedWebhookSecret: alreadyCurrent,
        },
      ] as Row[],
    };

    const result = await upgraded.reencryptSecrets(fakePrisma(tables));

    expect(result).toEqual({ migrated: 4, current: 2, unreadable: [] });
    expect(tables.envVar[1]?.value).toBe(alreadyCurrent);

    // Everything is now readable WITHOUT the fallback, i.e. by the dedicated key alone.
    const strict = await load({ ENCRYPTION_KEY: DEDICATED_KEY, ENCRYPTION_KEY_LEGACY_FALLBACK: undefined });
    expect(strict.decrypt(tables.envVar[0]?.value as string)).toBe("DB_PASSWORD=hunter2");
    expect(strict.decrypt(tables.user[0]?.totpSecretEncrypted as string)).toBe("JBSWY3DPEHPK3PXP");
    expect(strict.decrypt(tables.gitHubApp[0]?.encryptedPrivateKey as string)).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("changes nothing in a dry run", async () => {
    const { envCipher } = await legacyFixture();
    const upgraded = await load({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const tables = { envVar: [{ id: "e1", value: envCipher }] as Row[] };

    const result = await upgraded.reencryptSecrets(fakePrisma(tables), { dryRun: true });

    expect(result.migrated).toBe(1);
    expect(tables.envVar[0]?.value).toBe(envCipher);
  });

  it("is idempotent", async () => {
    const { envCipher } = await legacyFixture();
    const upgraded = await load({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const tables = { envVar: [{ id: "e1", value: envCipher }] as Row[] };
    const prisma = fakePrisma(tables);

    await upgraded.reencryptSecrets(prisma);
    const second = await upgraded.reencryptSecrets(prisma);

    expect(second).toEqual({ migrated: 0, current: 1, unreadable: [] });
  });

  it("reports but never overwrites values neither key can read", async () => {
    const upgraded = await load({
      ENCRYPTION_KEY: DEDICATED_KEY,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });
    const tables = {
      sftpUser: [{ id: "s1", encryptedPassword: "not-our-format" }] as Row[],
      envVar: [{ id: "e1", value: `${"00".repeat(12)}:${"11".repeat(16)}:abcd` }] as Row[],
    };

    const result = await upgraded.reencryptSecrets(fakePrisma(tables));

    expect(result.migrated).toBe(0);
    expect(result.unreadable).toEqual(["EnvVar.value e1", "SftpUser.encryptedPassword s1"].sort());
    expect(tables.sftpUser[0]?.encryptedPassword).toBe("not-our-format");
  });
});
