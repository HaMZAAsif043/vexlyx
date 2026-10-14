import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mockEnv = vi.hoisted(() => ({ PYTHON_BIN: undefined as string | undefined }));
vi.mock("../config/env.js", () => ({ env: mockEnv }));

const { getPythonBin } = await import("./pythonBin.js");

afterEach(() => {
  mockEnv.PYTHON_BIN = undefined;
  vi.unstubAllGlobals();
});

describe("getPythonBin", () => {
  it("uses the validated PYTHON_BIN setting when present", () => {
    mockEnv.PYTHON_BIN = "/opt/vexlyx/venv/bin/python";
    expect(getPythonBin()).toBe("/opt/vexlyx/venv/bin/python");
  });

  it("falls back to python3 on non-Windows hosts", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(getPythonBin()).toBe("python3");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("falls back to python on Windows hosts", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(getPythonBin()).toBe("python");
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});

const PY = '["\'`]python3?["\'`]';

/**
 * Finds the ways a module could pick a Python interpreter without going through
 * getPythonBin(): spawning a literal, assigning or defaulting to a literal, and
 * reading PYTHON_BIN directly. Comparisons (e.g. a framework name) and comments
 * are ignored.
 */
export function findInterpreterBypasses(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const patterns: Array<[string, RegExp]> = [
    [
      "spawns a literal interpreter",
      new RegExp(`\\b(?:spawn|execFile|exec|spawnSync|execFileSync)\\(\\s*${PY}`),
    ],
    ["assigns a literal interpreter", new RegExp(`(?<![=!<>])=\\s*${PY}`)],
    ["defaults to a literal interpreter", new RegExp(`(?:\\?\\?|\\|\\||\\?|:)\\s*${PY}`)],
    ["reads PYTHON_BIN directly", /\b(?:process\.)?env\.PYTHON_BIN\b/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
}

describe("findInterpreterBypasses (the guard itself)", () => {
  it.each([
    ["spawn literal", 'spawn("python", [script]);', "spawns a literal interpreter"],
    ["spawn literal python3", "execFile('python3', args);", "spawns a literal interpreter"],
    ["variable assigned a literal", 'const bin = "python";\nspawn(bin, [s]);', "assigns a literal interpreter"],
    ["nullish default", 'const bin = custom ?? "python3";', "defaults to a literal interpreter"],
    ["or default", 'const bin = custom || "python";', "defaults to a literal interpreter"],
    ["ternary", 'const bin = win ? "python" : "python3";', "defaults to a literal interpreter"],
    ["raw env read", "const bin = process.env.PYTHON_BIN;", "reads PYTHON_BIN directly"],
    ["validated env read", "const bin = env.PYTHON_BIN;", "reads PYTHON_BIN directly"],
  ])("flags %s", (_label, code, expected) => {
    expect(findInterpreterBypasses(code)).toContain(expected);
  });

  it.each([
    ["the helper", "const bin = getPythonBin();\nspawn(bin, [script]);"],
    ["a framework comparison", 'framework === "python" ? a : b'],
    ["an inequality", 'if (framework !== "python") return;'],
    ["a comment", '// defaults to "python" on win32\n/* env.PYTHON_BIN */'],
  ])("ignores %s", (_label, code) => {
    expect(findInterpreterBypasses(code)).toEqual([]);
  });
});

// Regression guard for #53: every Python script must be launched through
// getPythonBin(), otherwise a host whose interpreter is `python3` (stock Linux)
// or a custom PYTHON_BIN breaks only that one feature, confusingly.
describe("no module bypasses getPythonBin()", () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  const files = sourceFiles(srcRoot).filter(
    (file) => !file.endsWith(join("utils", "pythonBin.ts")),
  );

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no interpreter chosen outside the shared helper", () => {
    const offenders = files.flatMap((file) =>
      findInterpreterBypasses(readFileSync(file, "utf8")).map(
        (kind) => `${relative(srcRoot, file)}: ${kind}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
