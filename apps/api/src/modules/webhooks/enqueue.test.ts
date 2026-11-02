import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
});

const queueMock = vi.hoisted(() => ({ add: vi.fn(async (..._args: unknown[]) => undefined) }));

vi.mock("../../config/queue.js", () => ({
  createQueue: () => queueMock,
  createWorker: () => ({}),
}));
vi.mock("../../utils/encryption.js", () => ({
  decrypt: () => "app-webhook-secret",
  encrypt: (value: string) => value,
}));

import { webhookRoutes } from "./routes.js";
import { WebhookService } from "./service.js";

type DeploymentRow = {
  id: string;
  projectId: string;
  status: string;
  commitHash: string | null;
  buildLogs?: string;
  createdAt: Date;
};

function createStatefulPrisma(projects: Array<{ id: string; userId: string; branch: string; buildCmd: string | null }>) {
  const deployments: DeploymentRow[] = [];
  const prisma = {
    deployments,
    project: {
      findUnique: vi.fn(async () => ({
        id: "cproject000000000000000001",
        name: "site",
        userId: "user-1",
        gitUrl: null,
        branch: "main",
        buildCmd: null,
        webhookSecret: "project-webhook-secret",
        deletedAt: null,
      })),
      findMany: vi.fn(async () => projects),
    },
    gitHubApp: { findUnique: vi.fn(async () => ({ id: "singleton", encryptedWebhookSecret: "enc" })) },
    deployment: {
      create: vi.fn(async ({ data }: { data: { projectId: string; status: string; commitHash: string | null } }) => {
        const row: DeploymentRow = { id: `deployment-${deployments.length + 1}`, createdAt: new Date(), ...data };
        deployments.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DeploymentRow> }) => {
        const row = deployments.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("missing deployment");
        Object.assign(row, data);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; commitHash: string; status: { not: string } } }) =>
        deployments.find(
          (row) => row.projectId === where.projectId && row.commitHash === where.commitHash && row.status !== where.status.not,
        ) ?? null,
      ),
    },
  };
  return prisma;
}

function createRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

const sign = (payload: string, secret: string) => `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
const queuedDeployments = (prisma: { deployments: DeploymentRow[] }) => prisma.deployments.filter((row) => row.status === "QUEUED");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy webhook: enqueue failure", () => {
  const pushBody = JSON.stringify({ ref: "refs/heads/main", after: "abc1234567", head_commit: { id: "abc1234567", message: "ship it" } });
  const call = (service: WebhookService, enqueue: (data: never) => Promise<void>) =>
    service.handleGitHubWebhook(
      "cproject000000000000000001",
      "push",
      pushBody,
      sign(pushBody, "project-webhook-secret"),
      JSON.parse(pushBody),
      enqueue as never,
      "delivery-1",
    );

  it("leaves no QUEUED row behind when the queue is down", async () => {
    const prisma = createStatefulPrisma([]);
    const service = new WebhookService(prisma as never, undefined, createRedis() as never);

    await expect(call(service, vi.fn().mockRejectedValue(new Error("redis down")))).rejects.toThrow("redis down");

    expect(queuedDeployments(prisma)).toHaveLength(0);
    expect(prisma.deployments).toHaveLength(1);
    expect(prisma.deployments[0]).toMatchObject({ status: "FAILED" });
    expect(prisma.deployments[0]?.buildLogs).toContain("redis down");
  });

  it("succeeds on the retry with exactly one active deployment", async () => {
    const prisma = createStatefulPrisma([]);
    const service = new WebhookService(prisma as never, undefined, createRedis() as never);
    const enqueue = vi.fn().mockRejectedValueOnce(new Error("redis down")).mockResolvedValue(undefined);

    await expect(call(service, enqueue)).rejects.toThrow("redis down");
    const retry = await call(service, enqueue);

    expect(retry).toMatchObject({ success: true });
    expect(queuedDeployments(prisma)).toHaveLength(1);
    expect(prisma.deployments.map((row) => row.status)).toEqual(["FAILED", "QUEUED"]);
  });

  it("still reports the original enqueue error if marking the row FAILED also fails", async () => {
    const prisma = createStatefulPrisma([]);
    prisma.deployment.update.mockRejectedValue(new Error("db down"));
    const service = new WebhookService(prisma as never, undefined, createRedis() as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(call(service, vi.fn().mockRejectedValue(new Error("redis down")))).rejects.toThrow("redis down");
  });
});

describe("GitHub App webhook: enqueue failure", () => {
  const commit = "def7654321";
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: commit,
    head_commit: { id: commit, message: "ship it" },
    installation: { id: 7 },
    repository: { id: 11 },
  });

  async function buildApp(prisma: ReturnType<typeof createStatefulPrisma>) {
    const app = Fastify();
    app.decorate("prisma", prisma as never);
    app.decorate("redis", createRedis() as never);
    await app.register(webhookRoutes, { prefix: "/api/webhooks" });
    return app;
  }

  const deliver = (app: Awaited<ReturnType<typeof buildApp>>) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/github-app",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": sign(body, "app-webhook-secret"),
      },
    });

  const projects = [
    { id: "cproject000000000000000001", userId: "user-1", branch: "main", buildCmd: null },
    { id: "cproject000000000000000002", userId: "user-1", branch: "main", buildCmd: null },
  ];

  it("marks the failed row FAILED and lets the retry queue each project exactly once", async () => {
    const prisma = createStatefulPrisma(projects);
    const app = await buildApp(prisma);
    queueMock.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("redis down"));

    const failed = await deliver(app);
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(prisma.deployments.map((row) => [row.projectId, row.status])).toEqual([
      ["cproject000000000000000001", "QUEUED"],
      ["cproject000000000000000002", "FAILED"],
    ]);

    const retry = await deliver(app);

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ deploymentsQueued: 1 });
    expect(queuedDeployments(prisma).map((row) => row.projectId).sort()).toEqual([
      "cproject000000000000000001",
      "cproject000000000000000002",
    ]);
  });
});
