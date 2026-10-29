import fs from "node:fs/promises";
import path from "node:path";

/**
 * www-data in the php-fpm images (php:*-fpm-alpine, wordpress:*-fpm-alpine).
 * system/python/docker_manager.py defines the same constants; a test keeps
 * the two in step.
 */
export const PHP_FPM_UID = 82;
export const PHP_FPM_GID = 82;

/**
 * "project": no-build PHP serves the whole project directory.
 * "wp-content": WordPress only writes inside its bind-mounted wp-content.
 */
export type PhpOwnershipScope = "project" | "wp-content";

/** Panel-owned entries inside a project directory; PHP must never own them. */
const PANEL_OWNED = new Set(["deploy", ".git"]);

export function phpOwnershipScope(project: {
  type: string;
  buildCmd: string | null;
}): PhpOwnershipScope | null {
  if (project.type === "WORDPRESS") return "wp-content";
  if (project.type === "PHP" && !project.buildCmd) return "project";
  return null;
}

/** The folders WordPress writes to inside wp-content (matches docker_manager.py). */
export const WORDPRESS_WRITABLE_DIRS = ["plugins", "themes", "uploads"] as const;

/**
 * The directories whose ownership matters, without their contents: the
 * project directory itself for no-build PHP, wp-content and its writable
 * folders for WordPress. Deploys and the one-time repair both hand over
 * exactly these.
 */
export function phpDocrootTargets(projectDir: string, scope: PhpOwnershipScope): string[] {
  if (scope === "project") return [projectDir];
  const wpContent = path.join(projectDir, "wp-content");
  return [wpContent, ...WORDPRESS_WRITABLE_DIRS.map((name) => path.join(wpContent, name))];
}

/** Changing ownership needs root; in development the API usually is not. */
export function canChangeOwnership(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

type Chown = (target: string) => Promise<void>;

const lchownToPhp: Chown = (target) =>
  fs.lchown(target, PHP_FPM_UID, PHP_FPM_GID);

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function inScope(root: string, target: string, scope: PhpOwnershipScope): boolean {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (rel === "") return scope === "project";
  const [first] = rel.split(path.sep);
  if (scope === "wp-content") return first === "wp-content";
  return !PANEL_OWNED.has(first!);
}

/**
 * True when the project directory is a git checkout (it contains `.git`, a
 * directory or, for worktrees and submodules, a gitlink file or even a dangling
 * link: anything git would treat as the repository marker).
 *
 * The root of a checkout must stay root-owned. The panel runs git as root, and
 * git refuses a repository whose directory belongs to another user ("detected
 * dubious ownership"), which would break every pull, redeploy and auto-deploy.
 * Working around it with `safe.directory` is not an option: a PHP-owned root
 * could replace `.git`, and its hooks and config run as root on the next pull.
 */
export async function isGitCheckout(projectDir: string): Promise<boolean> {
  return fs.lstat(path.join(projectDir, ".git")).then(() => true, () => false);
}

/**
 * Hands files created by the panel (which runs as root) to the PHP-FPM user,
 * so PHP can modify what was uploaded or edited through the File Manager.
 * lchown never follows a symlink, and the walk only descends into real
 * directories, so a link planted by the application cannot redirect it.
 * The project root itself is skipped when the project is a git checkout.
 */
export async function handOverToPhp(
  root: string,
  targets: string[],
  scope: PhpOwnershipScope,
  options: { recursive?: boolean; chown?: Chown } = {},
): Promise<void> {
  const chown = options.chown ?? lchownToPhp;
  const keepRoot = scope === "project" && (await isGitCheckout(root));

  const visit = async (target: string): Promise<void> => {
    if (!inScope(root, target, scope)) return;
    try {
      if (!(keepRoot && path.relative(root, target) === "")) await chown(target);
      if (!options.recursive) return;
      const stat = await fs.lstat(target);
      if (!stat.isDirectory()) return;
      for (const name of await fs.readdir(target)) {
        await visit(path.join(target, name));
      }
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  };

  for (const target of targets) await visit(target);
}

/**
 * The directories `mkdir -p dir` would create, outermost first. Captured
 * before the mkdir so the new ones can be handed over afterwards.
 */
export async function missingAncestors(root: string, dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dir;
  while (current !== root && current !== path.dirname(current)) {
    const exists = await fs.lstat(current).then(() => true, () => false);
    if (exists) break;
    missing.unshift(current);
    current = path.dirname(current);
  }
  return missing;
}
