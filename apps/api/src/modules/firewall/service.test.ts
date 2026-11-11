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
const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
import { FirewallService } from "./service.js";
function fixture() {
  const rule = {
    id: "r1",
    port: 8080,
    protocol: "TCP",
    action: "ALLOW",
    source: null,
    comment: null,
    createdBy: "u1",
    createdAt: new Date(),
  };
  const prisma = {
    firewallRule: {
      create: vi.fn().mockResolvedValue(rule),
      findUnique: vi.fn().mockResolvedValue(rule),
      delete: vi.fn(),
    },
  };
  const audit = { log: vi.fn() };
  return {
    prisma,
    audit,
    service: new FirewallService(
      prisma as never,
      logger as never,
      audit as never,
    ),
  };
}
it("does not save or audit a rule when the helper rejects an SSH lockout", async () => {
  const { prisma, audit, service } = fixture();
  spawn.mockReturnValue(
    child({ error: "SSH lockout", code: "LOCKOUT_RISK" }, 1),
  );
  await expect(
    service.addRule("u1", {
      port: 22,
      protocol: "TCP",
      action: "DENY",
    } as never),
  ).rejects.toMatchObject({ code: "LOCKOUT_RISK", statusCode: 400 });
  expect(prisma.firewallRule.create).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});
it("preserves the stored rule when system deletion fails", async () => {
  const { prisma, audit, service } = fixture();
  spawn.mockReturnValue(child({ error: "UFW failed" }, 1));
  await expect(service.deleteRule("u1", "r1")).rejects.toThrow("UFW failed");
  expect(prisma.firewallRule.delete).not.toHaveBeenCalled();
  expect(audit.log).not.toHaveBeenCalled();
});
it("does not invoke the helper for an unknown rule", async () => {
  const { prisma, service } = fixture();
  prisma.firewallRule.findUnique.mockResolvedValue(null);
  await expect(service.deleteRule("u1", "unknown")).rejects.toMatchObject({
    code: "RULE_NOT_FOUND",
  });
  expect(spawn).not.toHaveBeenCalled();
});
it("persists and audits only after system deletion succeeds", async () => {
  const { prisma, audit, service } = fixture();
  const events: string[] = [];
  spawn.mockReturnValue(
    child({ success: true }, 0, (payload) => {
      expect(payload.command).toBe("delete_rule");
      events.push("helper");
    }),
  );
  prisma.firewallRule.delete.mockImplementation(async () => {
    events.push("delete");
  });
  audit.log.mockImplementation(async () => {
    events.push("audit");
  });
  await service.deleteRule("u1", "r1");
  expect(events).toEqual(["helper", "delete", "audit"]);
});
it("rejects a nonzero helper exit even when its JSON looks successful", async () => {
  const { prisma, service } = fixture();
  spawn.mockReturnValue(child({ success: true }, 1));
  await expect(service.deleteRule("u1", "r1")).rejects.toMatchObject({
    code: "SCRIPT_ERROR",
  });
  expect(prisma.firewallRule.delete).not.toHaveBeenCalled();
});
