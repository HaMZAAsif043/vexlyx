import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
});

const queueMock = vi.hoisted(() => ({ add: vi.fn(async (..._args: unknown[]) => undefined) }));

vi.mock("../../config/queue.js", () => ({
  createQueue: () => queueMock,
  createWorker: () => ({}),
}));

import { webhookRoutes } from "./routes.js";

const SECRET = "project-webhook-secret";
const PROJECT_ID = "cproject000000000000000001";
const body = JSON.stringify({ ref: "refs/heads/main", after: "abc1234567", head_commit: { id: "abc1234567", message: "ship it" } });

function sign(payload: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload, "utf8").digest("hex")}`;
}

async function buildApp(project: Record<string, unknown> | null): Promise<FastifyInstance> {
  const store = new Map<string, string>();
  const app = Fastify();
  app.decorate("prisma", {
    project: { findUnique: vi.fn(async () => project) },
    deployment: { create: vi.fn(async () => ({ id: "deployment-1" })) },
  } as never);
  app.decorate("redis", {
    set: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  } as never);
  await app.register(webhookRoutes, { prefix: "/api/webhooks" });
  return app;
}

const baseProject = {
  id: PROJECT_ID,
  name: "site",
  userId: "user-1",
  gitUrl: null,
  branch: "main",
  buildCmd: null,
  webhookSecret: SECRET,
  deletedAt: null,
};

function post(app: FastifyInstance, url: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    payload: body,
    headers: { "content-type": "application/json", "x-github-event": "push", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("legacy GitHub webhook routes", () => {
  it("accepts a valid signed delivery and queues one build", async () => {
    const app = await buildApp(baseProject);
    const response = await post(app, `/api/webhooks/github/${PROJECT_ID}`, {
      "x-hub-signature-256": sign(body),
      "x-github-delivery": "delivery-1",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ success: true, deploymentId: "deployment-1" });
    expect(queueMock.add).toHaveBeenCalledTimes(1);
  });

  it("returns the same 401 status and body for unknown, secretless and badly signed requests", async () => {
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "delivery-1" };
    const unknown = await post(await buildApp(null), `/api/webhooks/github/${PROJECT_ID}`, headers);
    const secretless = await post(await buildApp({ ...baseProject, webhookSecret: null }), `/api/webhooks/github/${PROJECT_ID}`, headers);
    const badSignature = await post(
      await buildApp(baseProject),
      `/api/webhooks/github/${PROJECT_ID}`,
      { ...headers, "x-hub-signature-256": sign(body, "wrong-secret") },
    );

    for (const response of [unknown, secretless, badSignature]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unknown.json());
    }
    expect(unknown.json()).toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE", details: {} });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it("ignores a replayed delivery on both route shapes", async () => {
    const app = await buildApp(baseProject);
    const headers = { "x-hub-signature-256": sign(body), "x-github-delivery": "delivery-1" };

    const first = await post(app, `/api/webhooks/github?projectId=${PROJECT_ID}`, headers);
    const replay = await post(app, `/api/webhooks/github/${PROJECT_ID}`, headers);

    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ignored: true, reason: "duplicate_delivery" });
    expect(queueMock.add).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed delivery without x-github-delivery with 400", async () => {
    const app = await buildApp(baseProject);
    const response = await post(app, `/api/webhooks/github/${PROJECT_ID}`, { "x-hub-signature-256": sign(body) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MISSING_DELIVERY_ID" });
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});
