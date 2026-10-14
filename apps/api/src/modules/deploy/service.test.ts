import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

const projectsDir = mkdtempSync(join(tmpdir(), "vexlyx-deploy-test-"));
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
process.env.PROJECTS_DIR = projectsDir;

const { DeployService, DeployError } = await import("./service.js");
const { EnvService, EnvError } = await import("../env/service.js");

const USER_ID = "u1";
const PROJECT_ID = "p1";

beforeAll(() => {
  mkdirSync(join(projectsDir, PROJECT_ID), { recursive: true });
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const prisma = {
    project: {
      findUnique: vi.fn().mockResolvedValue({
        id: PROJECT_ID,
        name: "my-app",
        type: "NODEJS",
        userId: USER_ID,
        port: 3000,
        gitUrl: null,
        buildCmd: null,
        deletedAt: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return { prisma, service: new DeployService(prisma as unknown as PrismaClient) };
}

describe("DeployService.deploy with undecryptable environment variables (#49)", () => {
  it("fails with ENV_DECRYPT_FAILED, naming the key, before touching project status", async () => {
    vi.spyOn(EnvService.prototype, "getDecryptedMap").mockRejectedValue(
      new EnvError('Could not decrypt environment variable "DB_PASSWORD".', "ENV_DECRYPT_FAILED", 500),
    );
    const { prisma, service } = fixture();

    const err = await service.deploy(USER_ID, PROJECT_ID, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeployError);
    expect(err).toMatchObject({ code: "ENV_DECRYPT_FAILED", statusCode: 500 });
    expect((err as Error).message).toContain('"DB_PASSWORD"');
    // The project must not be left stuck in CREATING.
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("does not wrap unrelated errors", async () => {
    vi.spyOn(EnvService.prototype, "getDecryptedMap").mockRejectedValue(new Error("db down"));
    const { service } = fixture();

    await expect(service.deploy(USER_ID, PROJECT_ID, {})).rejects.toThrow("db down");
  });
});
