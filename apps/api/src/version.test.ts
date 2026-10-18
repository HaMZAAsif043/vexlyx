import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VEXLYX_VERSION } from "@vexlyx/shared";

const repoRoot = resolve(import.meta.dirname, "../../..");

function packageVersion(relativePath: string): string {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as { version: string };
  return manifest.version;
}

// A release bumps every one of these together. This test fails if one is missed, so
// /api/health, the release tag and the package manifests can never disagree again.
describe("release version", () => {
  const manifests = ["package.json", "apps/api/package.json", "apps/dashboard/package.json", "packages/shared/package.json"];

  it.each(manifests)("%s matches VEXLYX_VERSION", (manifest) => {
    expect(packageVersion(manifest)).toBe(VEXLYX_VERSION);
  });

  it("is a plain MAJOR.MINOR.PATCH version, optionally with a prerelease suffix", () => {
    expect(VEXLYX_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
