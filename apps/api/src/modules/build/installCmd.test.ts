import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

const projectsDir = mkdtempSync(join(tmpdir(), "vexlyx-install-cmd-test-"));
process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
process.env.PROJECTS_DIR = projectsDir;

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { BuildService, createBuildProcessor } = await import("./service.js");
const { EnvService } = await import("../env/service.js");

const USER_ID = "u1";
const PROJECT_ID = "p1";

/** What build_manager.py's `plan` reports for a pnpm Next.js repository. */
const PLAN = {
  framework: "nextjs",
  detectedType: "NEXTJS",
  installCmd: "pnpm install",
  buildCmd: "pnpm run build",
  startCmd: "pnpm start",
};

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (chunk: string) => void; end: () => void };
  kill: () => boolean;
};

/**
 * Stands in for a build_manager.py process: `handler` sees the payload written
 * to stdin and returns the stdout plus exit code to answer with.
 */
function fakeChild(
  handler: (payload: string) => { stdout: string; code: number },
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let raw = "";
  child.stdin = {
    write: (chunk: string) => {
      raw += chunk;
    },
    end: () => {
      const { stdout, code } = handler(raw);
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", code);
      });
    },
  };
  return child;
}

/** Payloads handed to build_manager.py with `command: "build"`, in call order. */
let buildPayloads: Record<string, unknown>[];

beforeEach(() => {
  vi.resetAllMocks();
  buildPayloads = [];
  spawnMock.mockImplementation(() =>
    fakeChild((raw) => {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      if (payload.command === "plan") {
        return { stdout: JSON.stringify(PLAN), code: 0 };
      }
      if (payload.command === "build") {
        // Failing right after capturing the payload keeps the test inside the
        // build phase: the deploy chain is another module's contract. The
        // newline matters — build output is parsed one line at a time.
        buildPayloads.push(payload);
        return {
          stdout: `${JSON.stringify({ error: "stopped by test" })}\n`,
          code: 1,
        };
      }
      return {
        stdout: JSON.stringify({
          error: `unexpected command: ${payload.command}`,
        }),
        code: 1,
      };
    }),
  );
  vi.spyOn(EnvService.prototype, "getDecryptedMap").mockResolvedValue({});
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => rmSync(projectsDir, { recursive: true, force: true }));

function prismaMock(project: Record<string, unknown>) {
  return {
    project: {
      findUnique: vi.fn().mockResolvedValue(project),
      update: vi.fn().mockResolvedValue({}),
    },
    deployment: {
      create: vi.fn().mockResolvedValue(deployment()),
      update: vi.fn().mockResolvedValue({}),
    },
    cleanupSettings: {
      findUnique: vi.fn().mockResolvedValue({ pruneAfterRedeploy: false }),
    },
  };
}

function storedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    name: "ideact",
    type: "NEXTJS",
    userId: USER_ID,
    gitUrl: null,
    port: 3000,
    installCmd: null,
    startCmd: null,
    deletedAt: null,
    ...overrides,
  };
}

function deployment() {
  const ts = new Date("2026-10-31T00:00:00.000Z");
  return {
    id: "d1",
    status: "QUEUED",
    commitHash: null,
    commitMsg: null,
    buildLogs: null,
    duration: null,
    projectId: PROJECT_ID,
    createdAt: ts,
    updatedAt: ts,
  };
}

function logger(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info",
  } as unknown as FastifyBaseLogger;
}

/** Drives one queue job and returns the build payloads it produced. */
async function runJob(
  jobData: Record<string, unknown>,
  project: Record<string, unknown>,
) {
  const prisma = prismaMock(project);
  const process = createBuildProcessor(
    prisma as unknown as PrismaClient,
    logger(),
  );
  await process({ id: "j1", name: "build", data: jobData as never });
  return buildPayloads;
}

describe("build job install command", () => {
  const job = {
    deploymentId: "d1",
    projectId: PROJECT_ID,
    userId: USER_ID,
    projectDir: join(projectsDir, PROJECT_ID),
    imageName: "vexlyx-p1",
    installCmd: "npm ci --frozen-lockfile",
    buildCmd: "pnpm run build",
  };

  beforeEach(() => {
    mkdirSync(join(projectsDir, PROJECT_ID), { recursive: true });
    writeFileSync(join(projectsDir, PROJECT_ID, "package.json"), "{}");
  });

  it("puts this run's override in the payload sent to build_manager.py", async () => {
    await expect(runJob(job, storedProject())).rejects.toThrow(
      "stopped by test",
    );

    expect(buildPayloads).toHaveLength(1);
    expect(buildPayloads[0]!.installCmd).toBe("npm ci --frozen-lockfile");
  });

  it("uses the project's stored override when the job carries none", async () => {
    await expect(
      runJob(
        { ...job, installCmd: null },
        storedProject({ installCmd: "pnpm install --prod" }),
      ),
    ).rejects.toThrow("stopped by test");

    expect(buildPayloads[0]!.installCmd).toBe("pnpm install --prod");
  });

  it("falls back to the detected command when nothing is overridden", async () => {
    await expect(
      runJob({ ...job, installCmd: null }, storedProject()),
    ).rejects.toThrow("stopped by test");

    expect(buildPayloads[0]!.installCmd).toBe("pnpm install");
  });

  it("sends null so Nixpacks decides when neither the plan nor the project has one", async () => {
    spawnMock.mockImplementation(() =>
      fakeChild((raw) => {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        if (payload.command === "plan") {
          return {
            stdout: JSON.stringify({ ...PLAN, installCmd: null }),
            code: 0,
          };
        }
        buildPayloads.push(payload);
        return {
          stdout: `${JSON.stringify({ error: "stopped by test" })}\n`,
          code: 1,
        };
      }),
    );

    await expect(
      runJob({ ...job, installCmd: null }, storedProject()),
    ).rejects.toThrow("stopped by test");

    expect(buildPayloads[0]!.installCmd).toBeNull();
  });
});

describe("triggerBuild queueing", () => {
  beforeEach(() => {
    mkdirSync(join(projectsDir, PROJECT_ID), { recursive: true });
    writeFileSync(join(projectsDir, PROJECT_ID, "package.json"), "{}");
  });

  function service(project: Record<string, unknown>) {
    return new BuildService(prismaMock(project) as unknown as PrismaClient);
  }

  it("queues the stored override so the worker sees it", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(undefined);

    await service(storedProject({ installCmd: "pnpm install" })).triggerBuild(
      USER_ID,
      PROJECT_ID,
      {},
      enqueueJob,
    );

    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ installCmd: "pnpm install" }),
    );
  });

  it("lets a one-off request beat the stored override", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(undefined);

    await service(storedProject({ installCmd: "pnpm install" })).triggerBuild(
      USER_ID,
      PROJECT_ID,
      { installCmd: "npm ci" },
      enqueueJob,
    );

    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ installCmd: "npm ci" }),
    );
  });

  it("queues null when no override exists anywhere", async () => {
    const enqueueJob = vi.fn().mockResolvedValue(undefined);

    await service(storedProject()).triggerBuild(
      USER_ID,
      PROJECT_ID,
      {},
      enqueueJob,
    );

    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ installCmd: null }),
    );
  });
});

describe("getBuildPlan", () => {
  it("reports the install command auto-detection derived from the source", async () => {
    mkdirSync(join(projectsDir, PROJECT_ID), { recursive: true });
    writeFileSync(join(projectsDir, PROJECT_ID, "pnpm-lock.yaml"), "");

    const service = new BuildService(
      prismaMock(storedProject()) as unknown as PrismaClient,
    );

    await expect(service.getBuildPlan(USER_ID, PROJECT_ID)).resolves.toEqual({
      framework: "nextjs",
      detectedType: "NEXTJS",
      installCmd: "pnpm install",
      buildCmd: "pnpm run build",
      startCmd: "pnpm start",
    });
  });

  it("refuses another owner's project before spawning anything", async () => {
    const service = new BuildService(
      prismaMock(
        storedProject({ userId: "someone-else" }),
      ) as unknown as PrismaClient,
    );

    await expect(
      service.getBuildPlan(USER_ID, PROJECT_ID),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
