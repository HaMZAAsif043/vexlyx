import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogService } from "../audit-log/service.js";

const state = vi.hoisted(() => ({
  projectsDir: "",
  maxBytes: 10 * 1024 * 1024,
}));

vi.mock("../../config/env.js", () => ({
  env: {
    get PROJECTS_DIR() {
      return state.projectsDir;
    },
    PYTHON_BIN: undefined,
    get FILE_ARCHIVE_MAX_BYTES() {
      return state.maxBytes;
    },
    FILE_ARCHIVE_MAX_ENTRIES: 1000,
    FILE_ARCHIVE_MAX_RATIO: 1000,
  },
}));

import { FileError, FileService } from "./service.js";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const PROJECT_ID = "project-1";
const OWNER = "owner-1";
const isPosix = process.platform !== "win32";

function runPython(source: string, args: string[] = []) {
  execFileSync(PYTHON, ["-I", "-c", source, ...args], { stdio: "pipe" });
}

/** Builds a zip from {name: content} plus optional raw ZipInfo extras. */
function makeZip(target: string, entries: Record<string, string>, symlinkEntry?: string) {
  runPython(
    `
import sys, json, zipfile, stat
target, entries, link = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
with zipfile.ZipFile(target, "w") as zf:
    for name, content in entries.items():
        zf.writestr(name, content)
    if link:
        info = zipfile.ZipInfo(link)
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(info, "/etc/passwd")
`,
    [target, JSON.stringify(entries), symlinkEntry ?? ""],
  );
}

function makeTarGz(target: string, entries: Record<string, string>) {
  runPython(
    `
import sys, json, tarfile, io
target, entries = sys.argv[1], json.loads(sys.argv[2])
with tarfile.open(target, "w:gz") as tf:
    for name, content in entries.items():
        data = content.encode()
        info = tarfile.TarInfo(name)
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
`,
    [target, JSON.stringify(entries)],
  );
}

function listZip(target: string): string[] {
  const out = execFileSync(
    PYTHON,
    ["-I", "-c", "import sys,zipfile,json;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", target],
    { encoding: "utf-8" },
  );
  return JSON.parse(out) as string[];
}

async function exists(p: string) {
  return fs.lstat(p).then(() => true, () => false);
}

describe("FileService archives & permissions", { timeout: 30_000 }, () => {
  let sandbox: string;
  let root: string;
  let service: FileService;
  const auditLog = { log: vi.fn() };

  beforeAll(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-files-")));
    state.projectsDir = path.join(sandbox, "projects");
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = path.join(state.projectsDir, PROJECT_ID);
    await fs.rm(state.projectsDir, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    state.maxBytes = 10 * 1024 * 1024;
    auditLog.log.mockClear();

    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: PROJECT_ID, userId: OWNER, deletedAt: null }),
      },
    } as unknown as PrismaClient;
    service = new FileService(prisma, auditLog as unknown as AuditLogService);
  });

  describe("extract", () => {
    it("extracts a zip into the archive's own folder by default", async () => {
      await fs.mkdir(path.join(root, "site"));
      makeZip(path.join(root, "site", "pack.zip"), {
        "index.html": "<h1>hi</h1>",
        "assets/app.js": "console.log(1)",
        "empty/": "",
      });

      const result = await service.extract(OWNER, PROJECT_ID, "site/pack.zip");

      expect(result.extracted).toBe(2);
      expect(await fs.readFile(path.join(root, "site", "index.html"), "utf-8")).toBe("<h1>hi</h1>");
      expect(await fs.readFile(path.join(root, "site", "assets", "app.js"), "utf-8")).toBe("console.log(1)");
      expect(await exists(path.join(root, "site", "empty"))).toBe(true);
      expect(auditLog.log).toHaveBeenCalledWith(
        OWNER,
        "file.archive_extracted",
        { type: "Project", id: PROJECT_ID },
        expect.anything(),
      );
    });

    it("extracts tar.gz into a chosen destination", async () => {
      makeTarGz(path.join(root, "bundle.tar.gz"), { "a/b.txt": "tar-content" });

      await service.extract(OWNER, PROJECT_ID, "bundle.tar.gz", "out");

      expect(await fs.readFile(path.join(root, "out", "a", "b.txt"), "utf-8")).toBe("tar-content");
    });

    it("rejects a zip-slip archive and writes nothing outside the project", async () => {
      makeZip(path.join(root, "evil.zip"), { "ok.txt": "fine", "../../escaped.txt": "pwned" });

      await expect(service.extract(OWNER, PROJECT_ID, "evil.zip")).rejects.toMatchObject({
        code: "UNSAFE_ARCHIVE",
        statusCode: 422,
      });

      expect(await exists(path.join(sandbox, "escaped.txt"))).toBe(false);
      expect(await exists(path.join(state.projectsDir, "escaped.txt"))).toBe(false);
      // Whole archive is refused: the harmless entry is not written either.
      expect(await exists(path.join(root, "ok.txt"))).toBe(false);
    });

    it("rejects absolute entry paths", async () => {
      makeZip(path.join(root, "abs.zip"), { "/etc/cron.d/x": "bad" });

      await expect(service.extract(OWNER, PROJECT_ID, "abs.zip")).rejects.toMatchObject({
        code: "UNSAFE_ARCHIVE",
      });
    });

    it("rejects archives containing symbolic links", async () => {
      makeZip(path.join(root, "link.zip"), { "a.txt": "x" }, "shortcut");

      await expect(service.extract(OWNER, PROJECT_ID, "link.zip")).rejects.toMatchObject({
        code: "UNSAFE_ARCHIVE",
      });
      expect(await exists(path.join(root, "a.txt"))).toBe(false);
    });

    it("skips .env and wp-config.php entries and reports them", async () => {
      makeZip(path.join(root, "wp.zip"), {
        "index.php": "<?php",
        ".env": "SECRET=1",
        "wp-config.php": "<?php // cfg",
      });

      const result = await service.extract(OWNER, PROJECT_ID, "wp.zip");

      expect(result.extracted).toBe(1);
      expect(result.skipped.sort()).toEqual([".env", "wp-config.php"]);
      expect(await exists(path.join(root, ".env"))).toBe(false);
    });

    it("refuses to overwrite existing files unless asked", async () => {
      await fs.writeFile(path.join(root, "index.html"), "old");
      makeZip(path.join(root, "pack.zip"), { "index.html": "new" });

      await expect(service.extract(OWNER, PROJECT_ID, "pack.zip")).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
      });
      expect(await fs.readFile(path.join(root, "index.html"), "utf-8")).toBe("old");

      await service.extract(OWNER, PROJECT_ID, "pack.zip", undefined, true);
      expect(await fs.readFile(path.join(root, "index.html"), "utf-8")).toBe("new");
    });

    it("rejects archives that expand past the size limit", async () => {
      state.maxBytes = 100;
      makeZip(path.join(root, "big.zip"), { "big.txt": "x".repeat(500) });

      await expect(service.extract(OWNER, PROJECT_ID, "big.zip")).rejects.toMatchObject({
        code: "ARCHIVE_TOO_LARGE",
        statusCode: 413,
      });
      expect(await exists(path.join(root, "big.txt"))).toBe(false);
    });

    it("rejects corrupt and unsupported archives", async () => {
      await fs.writeFile(path.join(root, "broken.zip"), "not a zip");
      await fs.writeFile(path.join(root, "notes.rar"), "x");

      await expect(service.extract(OWNER, PROJECT_ID, "broken.zip")).rejects.toMatchObject({
        code: "CORRUPT_ARCHIVE",
      });
      await expect(service.extract(OWNER, PROJECT_ID, "notes.rar")).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    });

    it("rejects a destination outside the project", async () => {
      makeZip(path.join(root, "pack.zip"), { "a.txt": "x" });

      await expect(
        service.extract(OWNER, PROJECT_ID, "pack.zip", "../other"),
      ).rejects.toThrow(/traversal/i);
    });

    it("leaves no staging directory behind", async () => {
      makeZip(path.join(root, "pack.zip"), { "a.txt": "x" });
      await service.extract(OWNER, PROJECT_ID, "pack.zip");

      const leftovers = (await fs.readdir(root)).filter((n) => n.startsWith(".vexlyx-extract-"));
      expect(leftovers).toEqual([]);
    });
  });

  describe("compress", () => {
    it("zips exactly the selected files and folders", async () => {
      await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "lib", "a.ts"), "a");
      await fs.writeFile(path.join(root, "README.md"), "readme");
      await fs.writeFile(path.join(root, "unrelated.txt"), "nope");

      const result = await service.compress(OWNER, PROJECT_ID, ["src", "README.md"], "backup.zip");

      expect(result.files).toBe(2);
      const names = listZip(path.join(root, "backup.zip"));
      expect(names).toContain("src/lib/a.ts");
      expect(names).toContain("README.md");
      expect(names).not.toContain("unrelated.txt");
    });

    it("refuses to overwrite an existing archive", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "a");
      await fs.writeFile(path.join(root, "out.zip"), "existing");

      await expect(
        service.compress(OWNER, PROJECT_ID, ["a.txt"], "out.zip"),
      ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    });

    it("rejects selections that leave the project", async () => {
      await expect(
        service.compress(OWNER, PROJECT_ID, ["../../etc"], "x.zip"),
      ).rejects.toThrow(/traversal/i);
    });
  });

  describe("chmod", () => {
    it.skipIf(!isPosix)("changes a file mode and reports it in listings", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "a");

      await service.chmod(OWNER, PROJECT_ID, "a.txt", "640");

      const mode = (await fs.stat(path.join(root, "a.txt"))).mode & 0o777;
      expect(mode.toString(8)).toBe("640");
      const nodes = await service.listDir(OWNER, PROJECT_ID, "");
      expect(nodes.find((n) => n.name === "a.txt")?.mode).toBe("640");
    });

    it.skipIf(!isPosix)("does not recurse unless asked, and splits file/folder modes", async () => {
      await fs.mkdir(path.join(root, "dir", "sub"), { recursive: true });
      await fs.writeFile(path.join(root, "dir", "sub", "f.txt"), "f");

      await service.chmod(OWNER, PROJECT_ID, "dir", "750");
      expect(((await fs.stat(path.join(root, "dir", "sub", "f.txt"))).mode & 0o777)).not.toBe(0o750);

      const { changed } = await service.chmod(OWNER, PROJECT_ID, "dir", "755", true, "644");
      expect(changed).toBe(3);
      expect((await fs.stat(path.join(root, "dir", "sub"))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(root, "dir", "sub", "f.txt"))).mode & 0o777).toBe(0o644);
    });

    it.skipIf(!isPosix)("never follows symlinks out of the project", async () => {
      const outside = path.join(sandbox, "outside.txt");
      await fs.writeFile(outside, "o");
      await fs.chmod(outside, 0o600);
      await fs.mkdir(path.join(root, "dir"));
      await fs.symlink(outside, path.join(root, "dir", "link"));

      await service.chmod(OWNER, PROJECT_ID, "dir", "755", true, "666");

      expect((await fs.stat(outside)).mode & 0o777).toBe(0o600);
    });

    it("refuses the project root and lockout modes", async () => {
      await fs.mkdir(path.join(root, "dir"));
      await fs.writeFile(path.join(root, "a.txt"), "a");

      await expect(service.chmod(OWNER, PROJECT_ID, "", "755")).rejects.toMatchObject({
        code: "CHMOD_ROOT",
      });
      await expect(service.chmod(OWNER, PROJECT_ID, "dir", "555")).rejects.toMatchObject({
        code: "INVALID_MODE",
      });
      await expect(service.chmod(OWNER, PROJECT_ID, "a.txt", "044")).rejects.toMatchObject({
        code: "INVALID_MODE",
      });
      await expect(
        service.chmod(OWNER, PROJECT_ID, "a.txt", "644", true),
      ).rejects.toMatchObject({ code: "NOT_A_DIRECTORY" });
    });
  });

  describe("access control", () => {
    it("denies another user's project", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "a");

      const err = await service.chmod("intruder", PROJECT_ID, "a.txt", "644").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FileError);
      expect(err).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      await expect(
        service.extract("intruder", PROJECT_ID, "a.zip"),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        service.compress("intruder", PROJECT_ID, ["a.txt"], "x.zip"),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
