import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
});

import { WebhookError, WebhookService } from "./service.js";

const SECRET = "project-webhook-secret";
const PROJECT_ID = "cproject000000000000000001";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

const pushBody = JSON.stringify({
  ref: "refs/heads/main",
  after: "abc1234567",
  head_commit: { id: "abc1234567", message: "ship it" },
});

type ProjectRow = {
  id: string;
  name: string;
  userId: string;
  gitUrl: string | null;
  branch: string;
  buildCmd: string | null;
  webhookSecret: string | null;
  deletedAt: Date | null;
};

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT_ID,
    name: "site",
    userId: "user-1",
    gitUrl: "https://github.com/acme/site.git",
    branch: "main",
    buildCmd: null,
    webhookSecret: SECRET,
    deletedAt: null,
    ...overrides,
  };
}

function createRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

function createService(project: ProjectRow | null) {
  const prisma = {
    project: { findUnique: vi.fn(async () => project) },
    deployment: { create: vi.fn(async () => ({ id: "deployment-1" })) },
  };
  const redis = createRedis();
  const service = new WebhookService(prisma as never, undefined, redis as never);
  return { service, prisma, redis };
}

async function rejection(promise: Promise<unknown>): Promise<WebhookError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookError);
    return error as WebhookError;
  }
  throw new Error("Expected the webhook call to be rejected");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebhookService.handleGitHubWebhook", () => {
  it("queues a deployment for a valid, signed, first-time push", async () => {
    const { service, prisma } = createService(projectRow());
    const enqueue = vi.fn(async () => undefined);

    const result = await service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), enqueue, "delivery-1");

    expect(result).toMatchObject({ success: true, deploymentId: "deployment-1" });
    expect(prisma.deployment.create).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: "deployment-1", projectId: PROJECT_ID }));
  });

  it("answers a bad signature, an unknown project, a missing secret and a deleted project identically", async () => {
    const enqueue = vi.fn(async () => undefined);
    const cases: Array<[string, ProjectRow | null]> = [
      ["bad signature", projectRow({ webhookSecret: "another-secret" })],
      ["unknown project", null],
      ["no secret", projectRow({ webhookSecret: null })],
      ["deleted project", projectRow({ deletedAt: new Date() })],
    ];

    const errors: WebhookError[] = [];
    for (const [, project] of cases) {
      const { service } = createService(project);
      errors.push(await rejection(service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), enqueue, "delivery-1")));
    }

    for (const error of errors) {
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
      expect(error.message).toBe(errors[0]?.message);
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header with the same 401", async () => {
    const { service } = createService(projectRow());
    const error = await rejection(service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, undefined, JSON.parse(pushBody), vi.fn(), "delivery-1"));
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
  });

  it("ignores a replay of the same delivery ID", async () => {
    const { service, prisma } = createService(projectRow());
    const enqueue = vi.fn(async () => undefined);
    const call = () => service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), enqueue, "delivery-1");

    await call();
    const replay = await call();

    expect(replay).toMatchObject({ success: true, ignored: true, reason: "duplicate_delivery" });
    expect(prisma.deployment.create).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed request without a delivery ID with 400", async () => {
    const { service, redis } = createService(projectRow());
    const error = await rejection(service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), vi.fn(), undefined));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("MISSING_DELIVERY_ID");
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("does not let an unsigned request burn a delivery ID", async () => {
    const { service } = createService(projectRow());
    const enqueue = vi.fn(async () => undefined);

    await rejection(service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, "sha256=bad", JSON.parse(pushBody), enqueue, "delivery-1"));
    const result = await service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), enqueue, "delivery-1");

    expect(result).toMatchObject({ success: true, deploymentId: "deployment-1" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("releases the delivery claim when processing fails so GitHub's retry is handled", async () => {
    const { service } = createService(projectRow());
    const enqueue = vi.fn().mockRejectedValueOnce(new Error("redis down")).mockResolvedValue(undefined);
    const call = () => service.handleGitHubWebhook(PROJECT_ID, "push", pushBody, sign(pushBody), JSON.parse(pushBody), enqueue, "delivery-1");

    await expect(call()).rejects.toThrow("redis down");
    const retry = await call();

    expect(retry).toMatchObject({ success: true, deploymentId: "deployment-1" });
  });

  it("acknowledges a signed ping without deploying", async () => {
    const { service, prisma } = createService(projectRow());
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const result = await service.handleGitHubWebhook(PROJECT_ID, "ping", body, sign(body), JSON.parse(body), vi.fn(), "delivery-ping");
    expect(result.success).toBe(true);
    expect(prisma.deployment.create).not.toHaveBeenCalled();
  });
});
