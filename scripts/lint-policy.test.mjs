import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const eslint = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));

function lint(source, file) {
  const result = spawnSync(process.execPath, [eslint, "--stdin", "--stdin-filename", file, "--format", "json"], {
    cwd: root, input: source, encoding: "utf8", timeout: 30000,
  });
  assert.ifError(result.error);
  return { status: result.status, messages: JSON.parse(result.stdout)[0].messages };
}

for (const file of ["apps/api/src/__lint_policy_probe__.ts", "apps/dashboard/src/lib/__lint_policy_probe__.ts"]) {
  for (const [source, rule] of [
    ["export const probe: any = 1;", "@typescript-eslint/no-explicit-any"],
    ['console.log("probe"); export {};', "no-console"],
  ]) {
    test(`${file}: ${rule} fails the actual ESLint CLI`, () => {
      const result = lint(source, file);
      assert.equal(result.status, 1);
      assert.ok(result.messages.some(message => message.ruleId === rule && message.severity === 2));
    });
  }
  test(`${file}: typed code and operational warnings/errors pass`, () => {
    const result = lint('export const probe: unknown = 1; console.warn("warning"); console.error("error");', file);
    assert.equal(result.status, 0, JSON.stringify(result.messages));
  });
}
