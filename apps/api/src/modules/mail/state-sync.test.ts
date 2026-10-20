import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { reconcileMailState } from "./state-sync.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const data = { domains: ["one.example"], mailboxes: [], aliases: [] };
function processFixture() {
  const input: string[] = [];
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        input.push(String(chunk));
        callback();
      },
    }),
    kill: vi.fn(),
    input,
  });
}
let child: ReturnType<typeof processFixture>;
beforeEach(() => {
  child = processFixture();
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("mail state process protocol", () => {
  it("reads the global snapshot only after the cross-process lock is held", async () => {
    const snapshot = vi.fn(async () => data);
    const result = reconcileMailState(
      "python3",
      "postfix_manager.py",
      snapshot,
    );
    expect(snapshot).not.toHaveBeenCalled();
    child.stdout.write('{"rea');
    child.stdout.write('dy":true}\n');
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(child.input).toEqual([JSON.stringify(data) + "\n"]);
    child.stdout.write('{"success":true}');
    child.emit("close", 0);
    await expect(result).resolves.toBeUndefined();
  });

  it("rejects structured failures even when the subprocess exits zero", async () => {
    const result = reconcileMailState("python3", "script", async () => data);
    const assertion = expect(result).rejects.toMatchObject({
      code: "MAIL_STATE_ACTIVATION_FAILED",
      details: { rollbackFailed: ["postfix"] },
    });
    child.stdout.write(
      JSON.stringify({
        error: "Activation failed",
        code: "MAIL_STATE_ACTIVATION_FAILED",
        details: { rollbackFailed: ["postfix"] },
      }) + "\n",
    );
    child.emit("close", 0);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([0, 1])(
    "rejects exit %s without a completed synchronization",
    async (code) => {
      const result = reconcileMailState("python3", "script", async () => data);
      child.emit("close", code);
      await expect(result).rejects.toMatchObject({
        code: "MAIL_SYNC_PROCESS_ERROR",
      });
    },
  );

  it("rejects a nonzero exit after a success frame", async () => {
    const result = reconcileMailState("python3", "script", async () => data);
    child.stdout.write('{"ready":true}\n{"success":true}\n');
    child.emit("close", 1);
    await expect(result).rejects.toMatchObject({
      code: "MAIL_SYNC_PROCESS_ERROR",
    });
  });

  it.each([
    "not-json\n",
    '{"success":true}\n',
    "null\n",
    '{"ready":true}\n{"ready":true}\n',
  ])("rejects invalid protocol frames %s", async (frames) => {
    const result = reconcileMailState("python3", "script", async () => data);
    child.stdout.write(frames);
    await expect(result).rejects.toMatchObject({
      code: "MAIL_SYNC_PROTOCOL_ERROR",
    });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("releases the lock when the database snapshot fails without exposing details", async () => {
    const result = reconcileMailState("python3", "script", async () => {
      throw new Error("private database password");
    });
    const assertion = expect(result).rejects.toMatchObject({
      code: "MAIL_SYNC_DATABASE_ERROR",
      message: "Could not read the authoritative mail configuration.",
    });
    child.stdout.write('{"ready":true}\n');
    await assertion;
    expect(child.input).toEqual([]);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("bounds a stuck process and releases its lock", async () => {
    vi.useFakeTimers();
    const result = reconcileMailState("python3", "script", async () => data);
    const assertion = expect(result).rejects.toMatchObject({
      code: "MAIL_SYNC_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(420_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("handles spawn and stdin errors", async () => {
    const result = reconcileMailState("python3", "script", async () => data);
    child.stdin.emit("error", new Error("EPIPE"));
    child.emit("error", new Error("ENOENT"));
    await expect(result).rejects.toMatchObject({
      code: "MAIL_SYNC_PROCESS_ERROR",
    });
  });
});
