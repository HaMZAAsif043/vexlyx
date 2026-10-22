import type { ChildProcess } from "node:child_process";

/**
 * Backstop limits (ms) for the system/python/*.py scripts the API spawns.
 *
 * The Python managers enforce their own, tighter limits on the commands they
 * run (killing the real grandchild: docker, nixpacks, git, ...). These sit just
 * above those so the API never waits forever on a wedged script, and never
 * fires before the script has had the chance to report its own timeout.
 */
export const PYTHON_SCRIPT_TIMEOUT_MS = {
  /** nixpacks plan / dockerfile read-write. */
  quick: 180_000,
  /**
   * Static output extraction runs `docker create`, up to four `docker cp`
   * attempts and two cleanup commands, each allowed 120s by the script. The
   * backstop must cover their sum or valid work gets killed mid-way.
   */
  staticExtract: 900_000,
  /** One-shot status / inspect style commands. */
  status: 90_000,
  /** One-shot `compose logs`. */
  logs: 120_000,
  /** docker build / nixpacks build. */
  build: 3_660_000,
  /** docker compose up / start / stop / restart / down. */
  compose: 1_860_000,
  /**
   * `docker exec` of a scheduled task's command (F5.28). The script enforces
   * the task's own timeout (max 3600s) plus the in-container kill grace — the
   * backstop only has to sit above that.
   */
  exec: 3_780_000,
  /** git clone / fetch of a large repository. */
  git: 960_000,
  /** Database create / drop / test. */
  database: 180_000,
  /** Redis instance create / update / stats — first create may pull an image. */
  redis: 300_000,
  /** SFTP user provisioning. */
  sftp: 300_000,
  /** WordPress install / import / export (may stream a database dump). */
  wordpress: 1_860_000,
  /** Full-system backup / restore (archives and database dumps). */
  backup: 7_200_000,
  /** Docker prune/cleanup: container prune + image prune, 600s each in the script. */
  cleanup: 1_320_000,
  /** UFW rule changes and status. */
  firewall: 180_000,
  /** Status of every managed service, one `docker inspect` each. */
  services: 300_000,
  /** ACME/certificate operations. */
  ssl: 900_000,
  /** File Manager archive extract / compress; the script's own deadline is 480s. */
  archive: 540_000,
  /** postfix / dovecot / webmail manager commands. */
  mail: 300_000,
} as const;

/**
 * Kills `child` and calls `onTimeout` if it is still running after `timeoutMs`.
 * The timer clears itself when the process closes or fails to spawn.
 *
 * `onTimeout` runs before the kill so the caller's promise is settled with a
 * timeout error first; the `close` handler that follows the kill then finds an
 * already-settled promise and is a no-op.
 */
export function watchChildTimeout(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: (timeoutMs: number) => void,
): void {
  const timer = setTimeout(() => {
    onTimeout(timeoutMs);
    child.kill("SIGKILL");
  }, timeoutMs);

  const clear = () => clearTimeout(timer);
  child.once("close", clear);
  child.once("error", clear);
}
