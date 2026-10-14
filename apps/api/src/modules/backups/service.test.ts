import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Server } from "socket.io";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogService } from "../audit-log/service.js";

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  stopByProject: vi.fn(),
  spawn: vi.fn(),
  workspaceExists: true,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).includes("test-projects") ? mocks.workspaceExists : actual.existsSync(path),
  };
});
vi.mock("../../config/env.js", () => ({
  env: { PROJECTS_DIR: "test-projects" },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../deploy/service.js", () => ({
  DeployService: class {
    containerAction = mocks.action;
  },
  runDockerStopByProject: mocks.stopByProject,
}));
vi.mock("../domains/dns-service.js", () => ({ DnsService: class {} }));

import { BackupService } from "./service.js";

function setup(containerId: string | null = "container-1") {
  const project = {
    id: "project-1",
    userId: "owner-1",
    containerId,
    deletedAt: null,
  };
  const prisma = {
    project: { findUnique: vi.fn().mockResolvedValue(project) },
    backupSnapshot: {
      findUnique: vi.fn().mockResolvedValue({
        status: "COMPLETED",
        archivePath: "snapshot.tar.gz",
        manifest: { projects: [{ id: project.id }] },
      }),
    },
  };
  const logger = { error: vi.fn(), debug: vi.fn() };
  const audit = { log: vi.fn() };
  const emit = vi.fn();
  const io = { to: vi.fn().mockReturnValue({ emit }) };
  const service = new BackupService(
    prisma as unknown as PrismaClient,
    logger as unknown as FastifyBaseLogger,
    audit as unknown as AuditLogService,
  );
  return {
    logger,
    audit,
    emit,
    restore: () =>
      service.restoreItem(
        "admin-1",
        "snapshot-1",
        "project",
        project.id,
        io as unknown as Server,
      ),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspaceExists = true;
  mocks.stopByProject.mockResolvedValue(undefined);
  mocks.action.mockResolvedValue({ containerStatus: "exited" });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: {
        write: vi.fn(),
        end: vi.fn(() =>
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from('{"done":true}\n'));
            child.emit("close", 0);
          }),
        ),
      },
    });
    return child;
  });
});

describe("project restore safety", () => {
  it("aborts before extraction and success audit when stopping fails", async () => {
    mocks.action.mockRejectedValue(new Error("Docker stop failed"));
    const { restore, audit, emit, logger } = setup();
    await expect(restore()).rejects.toMatchObject({
      code: "RESTORE_STOP_FAILED",
      statusCode: 500,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(
      "owner-1",
      "project-1",
      "stop",
    );
    expect(audit.log).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      "restore:completed",
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("waits for stop confirmation before extracting and restarting", async () => {
    let finishStop!: () => void;
    mocks.action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const { restore, audit } = setup();
    const pending = restore();
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
    expect(mocks.spawn).not.toHaveBeenCalled();
    finishStop();
    await pending;
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.action).toHaveBeenNthCalledWith(
      2,
      "owner-1",
      "project-1",
      "start",
    );
    expect(audit.log).toHaveBeenCalledOnce();
  });

  it("restores projects without a container without attempting stop or start", async () => {
    const { restore, audit } = setup(null);
    await restore();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledOnce();
  });

  it("restores a soft-deleted project whose workspace is gone, stopping its containers by identity", async () => {
    mocks.workspaceExists = false;
    const { restore, audit, emit } = setup("container-1");

    await restore();

    // The compose file containerAction needs is gone, so the containers are
    // stopped and verified by project identity instead; the stale containerId
    // must not make the project unrecoverable.
    expect(mocks.action).not.toHaveBeenCalledWith("owner-1", "project-1", "stop");
    expect(mocks.stopByProject).toHaveBeenCalledWith("project-1");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      "restore:completed",
      expect.objectContaining({ status: "COMPLETED" }),
    );
  });

  it("aborts when containers of a workspace-less project cannot be confirmed stopped", async () => {
    mocks.workspaceExists = false;
    mocks.stopByProject.mockRejectedValue(new Error("containers still running"));
    const { restore, audit } = setup("container-1");

    await expect(restore()).rejects.toMatchObject({ code: "RESTORE_STOP_FAILED" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("still aborts when the workspace exists and stopping fails", async () => {
    mocks.workspaceExists = true;
    mocks.action.mockRejectedValue(new Error("docker unavailable"));
    const { restore, audit } = setup("container-1");

    await expect(restore()).rejects.toMatchObject({ code: "RESTORE_STOP_FAILED" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
