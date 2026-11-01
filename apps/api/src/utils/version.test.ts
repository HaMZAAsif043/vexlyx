import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./version.js";

describe("isNewerVersion", () => {
  it("detects a newer patch, minor and major release", () => {
    expect(isNewerVersion("0.4.3", "0.4.2")).toBe(true);
    expect(isNewerVersion("0.5.0", "0.4.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });

  it("treats the same or an older version as not newer", () => {
    expect(isNewerVersion("0.4.2", "0.4.2")).toBe(false);
    expect(isNewerVersion("0.4.10", "0.4.9")).toBe(true);
    expect(isNewerVersion("0.4.9", "0.4.10")).toBe(false);
  });

  it("accepts a leading v and ignores build metadata", () => {
    expect(isNewerVersion("v0.4.3", "0.4.2")).toBe(true);
    expect(isNewerVersion("0.4.2+build.7", "0.4.2")).toBe(false);
  });

  it("ranks a final release above its prereleases", () => {
    expect(isNewerVersion("0.4.3", "0.4.3-rc.1")).toBe(true);
    expect(isNewerVersion("0.4.3-rc.1", "0.4.3")).toBe(false);
    expect(isNewerVersion("0.4.3-rc.10", "0.4.3-rc.9")).toBe(true);
  });

  it("never reports an update for unparseable input", () => {
    expect(isNewerVersion("not-a-version", "0.4.2")).toBe(false);
    expect(isNewerVersion("0.4.3", "unknown")).toBe(false);
  });
});
