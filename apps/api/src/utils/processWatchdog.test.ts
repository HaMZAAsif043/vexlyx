import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { PYTHON_SCRIPT_TIMEOUT_MS, watchChildTimeout } from "./processWatchdog.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  return child as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

describe("PYTHON_SCRIPT_TIMEOUT_MS", () => {
  it("lets static output extraction finish all of its sequential commands", () => {
    // docker create + up to 4 docker cp + docker rm + docker rmi, each allowed 120s by the script.
    const worstCaseMs = (1 + 4 + 2) * 120_000;

    expect(PYTHON_SCRIPT_TIMEOUT_MS.staticExtract).toBeGreaterThanOrEqual(worstCaseMs);
  });

  it("keeps every backstop above the script-side limit it protects", () => {
    expect(PYTHON_SCRIPT_TIMEOUT_MS.build).toBeGreaterThan(3_600_000);
    expect(PYTHON_SCRIPT_TIMEOUT_MS.compose).toBeGreaterThan(1_800_000);
    expect(PYTHON_SCRIPT_TIMEOUT_MS.database).toBeGreaterThan(120_000);
  });
});

describe("watchChildTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the timeout and then SIGKILLs a child that is still running", () => {
    const child = fakeChild();
    const order: string[] = [];
    child.kill.mockImplementation(() => order.push("kill"));

    watchChildTimeout(child, 5_000, (ms) => order.push(`timeout:${ms}`));
    vi.advanceTimersByTime(4_999);
    expect(order).toEqual([]);

    vi.advanceTimersByTime(1);
    // The caller's promise must be settled with the timeout error before the
    // kill triggers the (then no-op) close handler.
    expect(order).toEqual(["timeout:5000", "kill"]);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does nothing when the child closes before the deadline", () => {
    const child = fakeChild();
    const onTimeout = vi.fn();

    watchChildTimeout(child, 5_000, onTimeout);
    child.emit("close", 0);
    vi.advanceTimersByTime(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does nothing when the child fails to spawn", () => {
    const child = fakeChild();
    const onTimeout = vi.fn();

    watchChildTimeout(child, 5_000, onTimeout);
    child.emit("error", new Error("spawn python3 ENOENT"));
    vi.advanceTimersByTime(60_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

// Regression guard for #52: a module that spawns a Python script directly
// must also arm the watchdog. (logs/service.ts is the intentionally unbounded
// `docker compose logs --follow` stream, ended by the client disconnecting.)
describe("every direct Python spawn is guarded", () => {
  const modulesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "modules");
  const STREAMING_EXCEPTIONS = new Set([join("logs", "service.ts")]);

  function serviceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return serviceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  const count = (text: string, needle: string) => text.split(needle).length - 1;

  // A launcher is any spawn() whose first argument is the Python interpreter,
  // whether written inline or held in a variable. `--version` probes are not
  // script launches.
  const LAUNCH = /\bspawn\(\s*(getPythonBin\(\)|getPythonExe\(\)|pythonBin|pythonExe)\s*,(?!\s*\[\s*["']--version["']\s*\])/g;

  it("arms watchChildTimeout for every Python script launch", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of serviceFiles(modulesDir)) {
      const rel = relative(modulesDir, file);
      if (STREAMING_EXCEPTIONS.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      const launches = (text.match(LAUNCH) ?? []).length;
      if (launches === 0) continue;
      checked += launches;
      if (count(text, "watchChildTimeout(") < launches) offenders.push(rel);
    }

    // 13 inline launches + backups, cleanup, firewall, monitoring, services,
    // ssl and the three mail managers.
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });

  it("recognises variable-held interpreters, not just the inline call", () => {
    expect('spawn(pythonBin, [scriptPath], {})'.match(LAUNCH)).toHaveLength(1);
    expect("spawn(pythonExe, [scriptPath, command], {})".match(LAUNCH)).toHaveLength(1);
    expect("spawn(getPythonBin(), [scriptPath], {})".match(LAUNCH)).toHaveLength(1);
    expect('spawn(pythonBin, ["--version"], {})'.match(LAUNCH)).toBeNull();
    expect("spawn('docker', ['ps'])".match(LAUNCH)).toBeNull();
  });
});
