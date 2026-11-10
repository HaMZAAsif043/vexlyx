const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

/**
 * Compares two release versions (with or without a leading `v`).
 * @param candidate - Version to test, e.g. a GitHub release tag
 * @param current - Version currently running
 * @returns True only when `candidate` is a strictly newer release
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;

  const [aMajor, aMinor, aPatch] = a.core;
  const [bMajor, bMinor, bPatch] = b.core;
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  if (aPatch !== bPatch) return aPatch > bPatch;

  // Same core version: the final release outranks its own prerelease, and two
  // prereleases compare segment-wise with numeric identifiers (rc.10 > rc.9).
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === "") return true;
  if (b.prerelease === "") return false;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true }) > 0;
}
