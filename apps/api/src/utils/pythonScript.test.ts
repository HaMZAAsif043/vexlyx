import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePythonScript } from "./pythonScript.js";
let temp: string;
let caller: string;
let candidates: string[];
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "vexlyx-scripts-"));
  const directory = path.join(temp, "package/apps/api/src/modules/build");
  caller = pathToFileURL(path.join(directory, "service.ts")).href;
  const cwd = path.join(temp, "work/apps/api");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  candidates = [
    path.resolve(directory, "../../../../../system/python/build_manager.py"),
    path.resolve(directory, "../../../../system/python/build_manager.py"),
    path.resolve(cwd, "../../system/python/build_manager.py"),
    path.resolve(cwd, "system/python/build_manager.py"),
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
it.each([0, 1, 2, 3])("resolves source/build or cwd candidate %i", (index) => {
  const expected = candidates[index]!;
  fs.mkdirSync(path.dirname(expected), { recursive: true });
  fs.writeFileSync(expected, "# helper");
  expect(resolvePythonScript("build_manager.py", caller)).toBe(expected);
});
it("keeps the original candidate priority when multiple installations exist", () => {
  for (const candidate of candidates) {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, "# helper");
  }
  expect(resolvePythonScript("build_manager.py", caller)).toBe(candidates[0]);
});
it("returns the canonical source-relative path when all candidates are absent", () => {
  expect(resolvePythonScript("build_manager.py", caller)).toBe(candidates[0]);
});
it.each(["../secret.py", "/tmp/helper.py", "helper.py/extra", "helper.exe"])(
  "rejects an invalid helper name %s",
  (name) => {
    expect(() => resolvePythonScript(name, caller)).toThrow(
      "Invalid Python helper name",
    );
  },
);
