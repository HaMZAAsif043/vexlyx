import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??=
    "test-session-secret-at-least-32-characters-long";
});
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
beforeEach(() => spawn.mockReset());
function child(
  result: unknown,
  code = 0,
  onCommand: (payload: Record<string, unknown>) => void = () => {},
) {
  const process = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: (body: string) => onCommand(JSON.parse(body)),
      end: () => {
        queueMicrotask(() => {
          process.stdout.emit(
            "data",
            Buffer.from(JSON.stringify(result) + "\n"),
          );
          process.emit("close", code);
        });
      },
    },
  });
  return process;
}
import { SftpService } from "./service.js";
function fixture(existing = true) {
  const record = {
    linuxUsername: "vex_user",
    encryptedPassword: "unchanged",
    isEnabled: true,
  };
  const prisma = {
    sftpUser: {
      findUnique: vi.fn().mockResolvedValue(existing ? record : null),
      create: vi.fn(),
      update: vi.fn(),
    },
    project: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { prisma, record, service: new SftpService(prisma as never) };
}
it("does not persist an account when Linux provisioning fails", async () => {
  const { prisma, service } = fixture(false);
  spawn.mockReturnValue(
    child({ error: "useradd failed", code: "PROVISION_FAILED" }, 1),
  );
  await expect(service.provision("u1")).rejects.toMatchObject({
    code: "PROVISION_FAILED",
  });
  expect(prisma.sftpUser.create).not.toHaveBeenCalled();
});
it.each(["rotatePassword", "disable", "addSshKey"] as const)(
  "preserves credentials/settings when %s fails",
  async (operation) => {
    const { prisma, record, service } = fixture();
    spawn.mockReturnValue(child({ error: "system failed" }, 1));
    await expect(
      operation === "addSshKey"
        ? service.addSshKey("u1", "ssh-ed25519 test")
        : service[operation]("u1"),
    ).rejects.toThrow("system failed");
    expect(prisma.sftpUser.update).not.toHaveBeenCalled();
    expect(record.encryptedPassword).toBe("unchanged");
    expect(prisma.sftpUser.findUnique).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
  },
);
it("does not invoke Linux commands for an unprovisioned account", async () => {
  const { service } = fixture(false);
  await expect(service.disable("u1")).rejects.toMatchObject({
    code: "SFTP_NOT_PROVISIONED",
  });
  expect(spawn).not.toHaveBeenCalled();
});
it("marks the account disabled only after helper success", async () => {
  const { prisma, service } = fixture();
  const events: string[] = [];
  spawn.mockReturnValue(
    child({ success: true }, 0, (payload) => {
      expect(payload.command).toBe("sftp-disable");
      events.push("helper");
    }),
  );
  prisma.sftpUser.update.mockImplementation(async () => {
    events.push("update");
  });
  await service.disable("u1");
  expect(events).toEqual(["helper", "update"]);
  expect(prisma.sftpUser.update).toHaveBeenCalledWith({
    where: { userId: "u1" },
    data: { isEnabled: false },
  });
});
