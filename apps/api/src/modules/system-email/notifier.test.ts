import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { SystemEmailService } from "./service.js";
import {
  notifyAdmins,
  notifyUser,
  registerSystemEmail,
  unregisterSystemEmail,
} from "./notifier.js";

function setupService() {
  const service = {
    notify: vi.fn<() => Promise<void>>(),
    notifyAdmins: vi.fn<() => Promise<void>>(),
  } as unknown as SystemEmailService;
  const error = vi.fn();
  const logger = { error } as unknown as FastifyBaseLogger;

  registerSystemEmail(service, logger);
  return { service, error };
}

let registeredService: SystemEmailService | null = null;

function registerTestService() {
  const setup = setupService();
  registeredService = setup.service;
  return setup;
}

afterEach(() => {
  if (registeredService) unregisterSystemEmail(registeredService);
  registeredService = null;
  vi.restoreAllMocks();
});

describe("system email notifier", () => {
  it("dispatches an admin notification once when the service resolves", async () => {
    const { service, error } = registerTestService();
    vi.mocked(service.notifyAdmins).mockResolvedValue(undefined);

    notifyAdmins("backup_failed", {
      error: "disk full",
      snapshotId: "snapshot-1",
    });

    await vi.waitFor(() => expect(service.notifyAdmins).toHaveBeenCalledOnce());
    expect(service.notifyAdmins).toHaveBeenCalledWith("backup_failed", {
      error: "disk full",
      snapshotId: "snapshot-1",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("catches and logs an admin notification rejection without exposing parameters", async () => {
    const { service, error } = registerTestService();
    const failure = new Error("database unavailable");
    vi.mocked(service.notifyAdmins).mockRejectedValue(failure);

    notifyAdmins("backup_failed", {
      error: "sensitive backup detail",
      snapshotId: "secret-snapshot",
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      { err: failure, event: "backup_failed", target: "admins" },
      "Failed to dispatch system email notification",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "sensitive backup detail",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-snapshot");
  });

  it("catches and logs a user notification rejection with its recipient", async () => {
    const { service, error } = registerTestService();
    const failure = new Error("queue unavailable");
    vi.mocked(service.notify).mockRejectedValue(failure);

    notifyUser("password_reset", "ada@example.com", {
      name: "Ada",
      resetUrl: "https://panel.example/reset-password#token=secret-token",
      expiresMinutes: 30,
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      {
        err: failure,
        event: "password_reset",
        target: "user",
        recipient: "ada@example.com",
      },
      "Failed to dispatch system email notification",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-token");
  });

  it("does not emit an unhandled rejection when notification dispatch rejects", async () => {
    const { service, error } = registerTestService();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    vi.mocked(service.notifyAdmins).mockRejectedValue(
      new Error("database unavailable"),
    );

    try {
      notifyAdmins("backup_failed", {
        error: "disk full",
        snapshotId: "snapshot-1",
      });
      await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("logs a pending notification failure after the service is unregistered", async () => {
    const { service, error } = registerTestService();
    let rejectNotification!: (reason?: unknown) => void;
    vi.mocked(service.notifyAdmins).mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectNotification = reject;
      }),
    );

    notifyAdmins("backup_failed", {
      error: "disk full",
      snapshotId: "snapshot-1",
    });
    unregisterSystemEmail(service);

    const failure = new Error("database connection closed");
    rejectNotification(failure);

    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      { err: failure, event: "backup_failed", target: "admins" },
      "Failed to dispatch system email notification",
    );
  });

  it("is a safe no-op before service registration", async () => {
    notifyAdmins("backup_failed", {
      error: "disk full",
      snapshotId: "snapshot-1",
    });
    notifyUser("password_changed", "ada@example.com", { name: "Ada" });

    await new Promise((resolve) => setImmediate(resolve));
  });
});
