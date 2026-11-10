import { afterEach, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSourceDirectory } from "./sourceDirectory.js";

const directories: string[] = [];
function temp() {
  const directory = mkdtempSync(join(tmpdir(), "build-source-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("uses the repository root by default and resolves a nested app", () => {
  const root = temp();
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  expect(resolveSourceDirectory(root)).toBe(root);
  expect(resolveSourceDirectory(root, "apps/web")).toBe(
    join(root, "apps", "web"),
  );
});
it.each([
  "../other",
  "/etc",
  "apps/../../other",
  ".git",
  "deploy",
  "apps/../web",
  "C:/other",
])("rejects an unsafe base directory %s", (directory) => {
  expect(() => resolveSourceDirectory(temp(), directory)).toThrow();
});
it("rejects a junction or symlink outside the project", () => {
  const root = temp();
  const outside = temp();
  symlinkSync(
    outside,
    join(root, "web"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => resolveSourceDirectory(root, "web")).toThrow("inside");
});
it("requires an existing directory", () => {
  const root = temp();
  writeFileSync(join(root, "web"), "not a directory");
  expect(() => resolveSourceDirectory(root, "web")).toThrow();
  expect(() => resolveSourceDirectory(root, "missing")).toThrow();
});
