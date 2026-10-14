import { describe, expect, it } from "vitest";
import { isFatalGitSyncError } from "./gitSyncPolicy.js";

describe("isFatalGitSyncError (#62)", () => {
  it("is fatal when the repository URL was rejected by the policy, even for a manual project", () => {
    const rejected = Object.assign(new Error("Unsupported Git repository URL"), {
      code: "INVALID_GIT_URL",
    });

    expect(isFatalGitSyncError(rejected, false)).toBe(true);
  });

  it("is fatal for a GitHub-linked project whatever the error", () => {
    expect(isFatalGitSyncError(new Error("network down"), true)).toBe(true);
  });

  it("lets a manual project fall back to its workspace on an ordinary sync failure", () => {
    const transient = Object.assign(new Error("Command failed"), { code: "COMMAND_FAILED" });

    expect(isFatalGitSyncError(transient, false)).toBe(false);
    expect(isFatalGitSyncError(new Error("timeout"), false)).toBe(false);
  });

  it.each([null, undefined, "INVALID_GIT_URL", 42])(
    "does not treat a non-error value as a policy rejection: %s",
    (value) => {
      expect(isFatalGitSyncError(value, false)).toBe(false);
    },
  );
});
