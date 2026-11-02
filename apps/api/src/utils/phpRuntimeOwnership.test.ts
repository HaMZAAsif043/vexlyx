import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PHP_FPM_GID,
  PHP_FPM_UID,
  handOverToPhp,
  missingAncestors,
  phpOwnershipScope,
} from "./phpRuntimeOwnership.js";

describe("phpOwnershipScope", () => {
  it.each([
    [{ type: "PHP", buildCmd: null }, "project"],
    [{ type: "PHP", buildCmd: "" }, "project"],
    [{ type: "WORDPRESS", buildCmd: null }, "wp-content"],
    [{ type: "PHP", buildCmd: "composer install" }, null],
    [{ type: "NODEJS", buildCmd: null }, null],
    [{ type: "STATIC", buildCmd: null }, null],
    [{ type: "DOCKER", buildCmd: null }, null],
  ] as const)("%j -> %s", (project, expected) => {
    expect(phpOwnershipScope(project)).toBe(expected);
  });
});

describe("PHP-FPM identity", () => {
  it("matches the uid the Python deploy layer assigns", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      path.resolve(here, "../../../../system/python/docker_manager.py"),
      "utf-8",
    );
    expect(py).toMatch(new RegExp(`^PHP_FPM_UID = ${PHP_FPM_UID}\r?$`, "m"));
    expect(py).toMatch(new RegExp(`^PHP_FPM_GID = ${PHP_FPM_GID}\r?$`, "m"));
  });
});

describe("handOverToPhp", () => {
  let root: string;
  let changed: string[];
  const record = async (p: string) => {
    changed.push(path.relative(root, p).replace(/\\/g, "/") || ".");
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-own-")));
    changed = [];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("hands a single file over", async () => {
    await fs.writeFile(path.join(root, "a.php"), "x");
    await handOverToPhp(root, [path.join(root, "a.php")], "project", { chown: record });
    expect(changed).toEqual(["a.php"]);
  });

  it("walks a directory tree when asked to", async () => {
    await fs.mkdir(path.join(root, "app", "src"), { recursive: true });
    await fs.writeFile(path.join(root, "app", "src", "x.php"), "x");
    await handOverToPhp(root, [path.join(root, "app")], "project", {
      chown: record,
      recursive: true,
    });
    expect(changed.sort()).toEqual(["app", "app/src", "app/src/x.php"]);
  });

  it("never touches the panel-owned deploy directory", async () => {
    await fs.mkdir(path.join(root, "deploy"));
    await fs.writeFile(path.join(root, "deploy", "docker-compose.yml"), "x");
    await fs.writeFile(path.join(root, "index.php"), "x");

    await handOverToPhp(root, [root], "project", { chown: record, recursive: true });

    expect(changed.sort()).toEqual([".", "index.php"]);
  });

  it("never touches .git, and in a checkout not the root either", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "x");
    await fs.writeFile(path.join(root, "index.php"), "x");

    await handOverToPhp(root, [root], "project", { chown: record, recursive: true });

    expect(changed).toEqual(["index.php"]);
  });

  it("refuses a target inside deploy even when named directly", async () => {
    await fs.mkdir(path.join(root, "deploy"));
    await handOverToPhp(root, [path.join(root, "deploy")], "project", { chown: record });
    expect(changed).toEqual([]);
  });

  it("limits a WordPress project to wp-content", async () => {
    await fs.mkdir(path.join(root, "wp-content", "uploads"), { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "x");

    await handOverToPhp(
      root,
      [root, path.join(root, "notes.txt"), path.join(root, "wp-content")],
      "wp-content",
      { chown: record, recursive: true },
    );

    expect(changed.sort()).toEqual(["wp-content", "wp-content/uploads"]);
  });

  it("does not follow a symlink out of the tree", async () => {
    if (process.platform === "win32") return;
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-outside-"));
    await fs.writeFile(path.join(outside, "secret"), "x");
    await fs.symlink(outside, path.join(root, "link"));

    await handOverToPhp(root, [root], "project", { chown: record, recursive: true });

    expect(changed.sort()).toEqual([".", "link"]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("ignores entries that vanished", async () => {
    await handOverToPhp(root, [path.join(root, "gone.php")], "project", {
      chown: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
  });

  it("rethrows other failures", async () => {
    await fs.writeFile(path.join(root, "a.php"), "x");
    await expect(
      handOverToPhp(root, [path.join(root, "a.php")], "project", {
        chown: async () => {
          throw Object.assign(new Error("nope"), { code: "EPERM" });
        },
      }),
    ).rejects.toThrow("nope");
  });
});

describe("handOverToPhp in a git checkout", () => {
  // The panel runs git as root. Once PHP owns the project directory git refuses
  // the repository ("dubious ownership"), and PHP could also replace .git, whose
  // hooks and config then run as root on the next pull. So the root of a
  // checkout is never handed over; what is inside it still is.
  let root: string;
  let changed: string[];
  const record = async (p: string) => {
    changed.push(path.relative(root, p).replace(/\\/g, "/") || ".");
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-git-")));
    changed = [];
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "a.php"), "x");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not hand the root over when it contains .git", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await handOverToPhp(root, [root], "project", { chown: record });
    expect(changed).toEqual([]);
  });

  it("treats a .git file (worktree or submodule) as a checkout too", async () => {
    await fs.writeFile(path.join(root, ".git"), "gitdir: /elsewhere\n");
    await handOverToPhp(root, [root], "project", { chown: record });
    expect(changed).toEqual([]);
  });

  it("still hands over the contents when asked to walk the tree, but never the root or .git", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await handOverToPhp(root, [root], "project", { chown: record, recursive: true });
    expect(changed.sort()).toEqual(["sub", "sub/a.php"]);
  });

  it("hands over files and folders inside a checkout", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await handOverToPhp(root, [path.join(root, "sub"), path.join(root, "sub", "a.php")], "project", { chown: record });
    expect(changed).toEqual(["sub", "sub/a.php"]);
  });

  it("still hands the root of a plain no-build project over", async () => {
    await handOverToPhp(root, [root], "project", { chown: record });
    expect(changed).toEqual(["."]);
  });

  it("does not mistake a file that merely starts with .git for a checkout", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "x");
    await handOverToPhp(root, [root], "project", { chown: record });
    expect(changed).toEqual(["."]);
  });

  it("leaves the WordPress scope alone", async () => {
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(path.join(root, "wp-content"));
    await handOverToPhp(root, [path.join(root, "wp-content")], "wp-content", { chown: record });
    expect(changed).toEqual(["wp-content"]);
  });
});

describe("missingAncestors", () => {
  it("lists the directories a recursive mkdir would create, outermost first", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-anc-")));
    await fs.mkdir(path.join(root, "a"));

    const missing = await missingAncestors(root, path.join(root, "a", "b", "c"));

    expect(missing.map((p) => path.relative(root, p).replace(/\\/g, "/"))).toEqual([
      "a/b",
      "a/b/c",
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is empty when the directory exists", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-anc-")));
    expect(await missingAncestors(root, root)).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
