import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { EnvService, EnvError } = await import("./service.js");
const { encrypt } = await import("../../utils/encryption.js");

const USER_ID = "u1";
const PROJECT_ID = "p1";

function record(key: string, value: string) {
  return { id: `id-${key}`, key, value: encrypt(value), createdAt: new Date(), updatedAt: new Date() };
}

function corrupted(key: string) {
  return { ...record(key, "x"), value: "not-a-valid-ciphertext" };
}

function fixture(records: ReturnType<typeof record>[]) {
  const prisma = {
    envVar: {
      findMany: vi.fn().mockResolvedValue(records),
      findUnique: vi.fn().mockImplementation(async ({ where }) =>
        records.find((r) => r.key === where.projectId_key.key) ?? null,
      ),
    },
    project: {
      findUnique: vi.fn().mockResolvedValue({ id: PROJECT_ID, userId: USER_ID, deletedAt: null }),
    },
  };
  return { prisma, service: new EnvService(prisma as unknown as PrismaClient) };
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("EnvService.getDecryptedMap (#49)", () => {
  it("returns every variable decrypted", async () => {
    const { service } = fixture([record("DB_PASSWORD", "s3cret"), record("API_KEY", "abc123")]);

    await expect(service.getDecryptedMap(PROJECT_ID)).resolves.toEqual({
      DB_PASSWORD: "s3cret",
      API_KEY: "abc123",
    });
  });

  it("returns an intentionally empty value as an empty string, not a decrypt failure", async () => {
    const { service } = fixture([record("OPTIONAL_FLAG", ""), record("API_KEY", "abc123")]);

    await expect(service.getDecryptedMap(PROJECT_ID)).resolves.toEqual({
      OPTIONAL_FLAG: "",
      API_KEY: "abc123",
    });
  });

  it("returns an empty map for a project with no variables", async () => {
    const { service } = fixture([]);

    await expect(service.getDecryptedMap(PROJECT_ID)).resolves.toEqual({});
  });

  it("throws ENV_DECRYPT_FAILED naming the key instead of substituting an empty string", async () => {
    const { service } = fixture([record("API_KEY", "abc123"), corrupted("DB_PASSWORD")]);

    const err = await failureOf(service.getDecryptedMap(PROJECT_ID));

    expect(err).toBeInstanceOf(EnvError);
    expect(err).toMatchObject({ code: "ENV_DECRYPT_FAILED", statusCode: 500 });
    expect((err as Error).message).toContain('"DB_PASSWORD"');
    expect((err as Error).message).not.toContain("API_KEY");
  });

  it("names every affected key in a single error", async () => {
    const { service } = fixture([corrupted("DB_PASSWORD"), record("OK", "1"), corrupted("API_KEY")]);

    const err = await failureOf(service.getDecryptedMap(PROJECT_ID));

    expect(err).toMatchObject({ code: "ENV_DECRYPT_FAILED" });
    expect((err as Error).message).toContain('"DB_PASSWORD"');
    expect((err as Error).message).toContain('"API_KEY"');
    expect((err as Error).message).not.toContain('"OK"');
  });

  it("treats a ciphertext that fails authentication as a failure, not an empty value", async () => {
    const good = record("API_KEY", "abc123");
    const [iv, tag, data] = good.value.split(":") as [string, string, string];
    const tampered = { ...good, value: `${iv}:${tag}:${data.replace(/.$/, data.endsWith("0") ? "1" : "0")}` };
    const { service } = fixture([tampered]);

    await expect(service.getDecryptedMap(PROJECT_ID)).rejects.toMatchObject({
      code: "ENV_DECRYPT_FAILED",
    });
  });
});

describe("EnvService.reveal (#49)", () => {
  it("returns the decrypted value", async () => {
    const { service } = fixture([record("API_KEY", "abc123")]);

    await expect(service.reveal(USER_ID, PROJECT_ID, "API_KEY")).resolves.toMatchObject({
      key: "API_KEY",
      value: "abc123",
    });
  });

  it("reports ENV_DECRYPT_FAILED with the key so the UI can ask to re-enter it", async () => {
    const { service } = fixture([corrupted("API_KEY")]);

    const err = await failureOf(service.reveal(USER_ID, PROJECT_ID, "API_KEY"));

    expect(err).toMatchObject({ code: "ENV_DECRYPT_FAILED", statusCode: 500 });
    expect((err as Error).message).toContain('"API_KEY"');
  });
});
