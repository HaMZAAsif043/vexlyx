import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
});

vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({ add: vi.fn() }),
  createWorker: () => ({}),
}));
vi.mock("../../utils/encryption.js", () => ({
  decrypt: () => "app-webhook-secret",
  encrypt: (value: string) => value,
}));

import { webhookRoutes } from "./routes.js";

interface InstallationState {
  status: string;
  suspendedAt: Date | null;
  disconnectedAt: Date | null;
}

async function setup(initial: InstallationState) {
  const installation = { ...initial };
  const prisma = {
    gitHubApp: {
      findUnique: vi.fn(async () => ({ id: "singleton", encryptedWebhookSecret: "encrypted" })),
    },
    gitHubInstallation: {
      updateMany: vi.fn(async ({ where, data }: {
        where: { disconnectedAt?: null };
        data: Partial<InstallationState>;
      }) => {
        if (where.disconnectedAt === null && installation.disconnectedAt !== null) return { count: 0 };
        Object.assign(installation, data);
        return { count: 1 };
      }),
    },
    project: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const deliveries = new Set<string>();
  const redis = {
    set: vi.fn(async (key: string) => {
      if (deliveries.has(key)) return null;
      deliveries.add(key);
      return "OK";
    }),
    del: vi.fn(async (key: string) => deliveries.delete(key) ? 1 : 0),
  };
  const app = Fastify();
  app.decorate("prisma", prisma as never);
  app.decorate("redis", redis as never);
  await app.register(webhookRoutes, { prefix: "/api/webhooks" });

  const deliver = async (action: string) => {
    const body = JSON.stringify({ action, installation: { id: 7 } });
    const signature = createHmac("sha256", "app-webhook-secret").update(body).digest("hex");
    return app.inject({
      method: "POST",
      url: "/api/webhooks/github-app",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": `delivery-${action}`,
        "x-hub-signature-256": `sha256=${signature}`,
      },
    });
  };

  return { installation, prisma, deliver };
}

describe("GitHub App installation lifecycle", () => {
  it.each(["created", "unsuspend", "new_permissions_accepted", "suspend"])(
    "does not revive a locally disconnected installation on %s",
    async (action) => {
      const disconnectedAt = new Date("2026-01-01T00:00:00Z");
      const { installation, prisma, deliver } = await setup({
        status: "DISCONNECTED",
        suspendedAt: null,
        disconnectedAt,
      });

      const response = await deliver(action);

      expect(response.statusCode).toBe(200);
      expect(installation).toEqual({ status: "DISCONNECTED", suspendedAt: null, disconnectedAt });
      expect(prisma.project.updateMany).not.toHaveBeenCalled();
    },
  );

  it("restores a suspended installation on unsuspend", async () => {
    const { installation, prisma, deliver } = await setup({
      status: "SUSPENDED",
      suspendedAt: new Date("2026-01-01T00:00:00Z"),
      disconnectedAt: null,
    });

    await deliver("unsuspend");

    expect(installation).toEqual({ status: "CONNECTED", suspendedAt: null, disconnectedAt: null });
    expect(prisma.project.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { githubInstallation: { installationId: 7n }, githubConnectionStatus: "SUSPENDED" },
      data: { githubConnectionStatus: "CONNECTED", githubDisconnectReason: null },
    });
  });

  it("marks an installation and its projects disconnected on deletion", async () => {
    const { installation, prisma, deliver } = await setup({
      status: "CONNECTED",
      suspendedAt: null,
      disconnectedAt: null,
    });

    await deliver("deleted");

    expect(installation).toEqual({
      status: "DISCONNECTED",
      suspendedAt: null,
      disconnectedAt: expect.any(Date),
    });
    expect(prisma.project.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { githubInstallation: { installationId: 7n } },
      data: { githubConnectionStatus: "DISCONNECTED", githubDisconnectReason: "GitHub App uninstalled" },
    });
  });
});
