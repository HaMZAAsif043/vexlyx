import fs from "node:fs";
import path from "node:path";

/** Locate a Docker config directory consistently from repo or API cwd. */
export function configDir(name: "coredns/zones" | "traefik/dynamic"): string {
  const candidates = ["docker", "../../docker", "../docker"].map((base) =>
    path.resolve(process.cwd(), base, name),
  );
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;
  const fallback = candidates[1]!;
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    /* Callers report write failures with context. */
  }
  return fallback;
}
