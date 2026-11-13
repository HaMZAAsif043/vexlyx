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
import { CleanupService } from "./service.js";
function fixture() {
  const prisma = {
    cleanupRun: {
      create: vi.fn().mockResolvedValue({ id: "run1" }),
      update: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => data,
      ),
    },
  };
  return {
    prisma,
    service: new CleanupService(prisma as never, logger as never),
  };
}
it("records helper failure without recording successful counts or continuing", async () => {
  const { service, prisma } = fixture();
  spawn.mockReturnValue(
    child(
      { error: "container prune failed", code: "CONTAINER_PRUNE_FAILED" },
      1,
    ),
  );
  const result = await service.runCleanup("MANUAL");
  expect(result).toMatchObject({
    status: "FAILED",
    error: "container prune failed",
  });
  expect(result).not.toHaveProperty("containersRemoved");
  expect(prisma.cleanupRun.update).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("records a nonzero helper exit as failure even with a success-shaped response", async () => {
  const { service } = fixture();
  spawn.mockReturnValue(child({ done: true, reclaimedBytes: 1 }, 1));
  expect(await service.runCleanup("MANUAL")).toMatchObject({
    status: "FAILED",
  });
});
it("records successful cleanup counts only after the helper completes", async () => {
  const { service } = fixture();
  let submitted: Record<string, unknown> = {};
  spawn.mockReturnValue(
    child(
      {
        done: true,
        containersRemoved: 2,
        imagesRemoved: 3,
        reclaimedBytes: 2048,
      },
      0,
      (payload) => {
        submitted = payload;
      },
    ),
  );
  expect(await service.runCleanup("MANUAL")).toMatchObject({
    status: "COMPLETED",
    containersRemoved: 2,
    imagesRemoved: 3,
    reclaimedBytes: 2048n,
  });
  expect(submitted).toEqual({ command: "cleanup" });
});
