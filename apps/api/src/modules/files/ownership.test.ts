import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const state = vi.hoisted(() => ({ projectsDir: "" }));

vi.mock("../../config/env.js", () => ({
  env: {
    get PROJECTS_DIR() {
      return state.projectsDir;
    },
    PYTHON_BIN: undefined,
    FILE_ARCHIVE_MAX_BYTES: 10 * 1024 * 1024,
    FILE_ARCHIVE_MAX_ENTRIES: 1000,
    FILE_ARCHIVE_MAX_RATIO: 1000,
  },
}));

import { FileService } from "./service.js";

const PROJECT_ID = "project-1";
const OWNER = "owner-1";
const PYTHON = process.platform === "win32" ? "python" : "python3";

type ProjectShape = { type: string; buildCmd: string | null };

// process.getuid does not exist on Windows, so it is defined rather than spied on.
const realGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
function setUid(uid: number) {
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true });
}
const PHP_NO_BUILD: ProjectShape = { type: "PHP", buildCmd: null };

describe("File Manager hands PHP projects' files to PHP-FPM (#151)", () => {
  let sandbox: string;
  let root: string;
  let lchown: MockInstance<typeof fs.lchown>;
  let logger: { warn: ReturnType<typeof vi.fn> };

  const owned = () =>
    lchown.mock.calls.map(([p]: Parameters<typeof fs.lchown>) => path.relative(root, String(p)).replace(/\\/g, "/"));

  function serviceFor(project: ProjectShape) {
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: PROJECT_ID,
          userId: OWNER,
          deletedAt: null,
          ...project,
        }),
      },
    } as unknown as PrismaClient;
    return new FileService(prisma, { log: vi.fn() } as never, logger as unknown as Pick<FastifyBaseLogger, "warn">);
  }

  beforeAll(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-own-fm-")));
    state.projectsDir = path.join(sandbox, "projects");
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = path.join(state.projectsDir, PROJECT_ID);
    await fs.rm(state.projectsDir, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    logger = { warn: vi.fn() };
    setUid(0);
    lchown = vi.spyOn(fs, "lchown").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (realGetuid) Object.defineProperty(process, "getuid", realGetuid);
    else delete (process as { getuid?: unknown }).getuid;
  });

  it("hands over a file created in the File Manager, with the user and group of www-data", async () => {
    await serviceFor(PHP_NO_BUILD).createFile(OWNER, PROJECT_ID, "settings.php", "<?php");

    expect(owned()).toEqual(["settings.php"]);
    expect(lchown).toHaveBeenCalledWith(expect.any(String), 82, 82);
  });

  it("hands over the folders it had to create as well as the file", async () => {
    await fs.mkdir(path.join(root, "existing"));
    await serviceFor(PHP_NO_BUILD).createFile(OWNER, PROJECT_ID, "existing/new/deep/a.php", "x");

    expect(owned()).toEqual(["existing/new", "existing/new/deep", "existing/new/deep/a.php"]);
  });

  it("hands over a saved edit", async () => {
    await fs.writeFile(path.join(root, "a.php"), "old");
    await serviceFor(PHP_NO_BUILD).writeFile(OWNER, PROJECT_ID, "a.php", "new");

    expect(owned()).toEqual(["a.php"]);
  });

  it("hands over the final uploaded file, not just its temporary name", async () => {
    await serviceFor(PHP_NO_BUILD).writeUploadStream(
      OWNER,
      PROJECT_ID,
      "installer.php",
      Readable.from(["<?php"]),
    );

    expect(owned()).toEqual(["installer.php"]);
    expect(await fs.readdir(root)).toEqual(["installer.php"]);
  });

  it("hands over an overwritten upload", async () => {
    await fs.writeFile(path.join(root, "installer.php"), "old");
    await serviceFor(PHP_NO_BUILD).writeUploadStream(
      OWNER,
      PROJECT_ID,
      "installer.php",
      Readable.from(["new"]),
      true,
    );

    expect(owned()).toEqual(["installer.php"]);
  });

  it("does not hand over a failed upload", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("aborted"));
      },
    });
    await expect(
      serviceFor(PHP_NO_BUILD).writeUploadStream(OWNER, PROJECT_ID, "a.php", failing),
    ).rejects.toThrow("aborted");

    expect(owned()).toEqual([]);
  });

  it("hands over created folders", async () => {
    await serviceFor(PHP_NO_BUILD).mkdir(OWNER, PROJECT_ID, "a/b");

    expect(owned()).toEqual(["a", "a/b"]);
  });

  it("hands over a copied tree", async () => {
    await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "lib", "x.php"), "x");
    await serviceFor(PHP_NO_BUILD).copy(OWNER, PROJECT_ID, "src", "backup");

    expect(owned().sort()).toEqual(["backup", "backup/lib", "backup/lib/x.php"]);
  });

  it("hands over extracted files", async () => {
    execFileSync(
      PYTHON,
      [
        "-I",
        "-c",
        "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    z.writestr('site/index.php', 'x')\n    z.writestr('site/inc/a.php', 'x')",
        path.join(root, "site.zip"),
      ],
      { stdio: "pipe" },
    );

    await serviceFor(PHP_NO_BUILD).extract(OWNER, PROJECT_ID, "site.zip", "out");

    expect(owned().sort()).toEqual(["out", "out/site", "out/site/inc", "out/site/inc/a.php", "out/site/index.php"]);
  });

  describe("a project that is a git checkout", () => {
    // git runs as root in the panel; a root directory owned by uid 82 makes it
    // fail with "dubious ownership", and PHP could replace .git.
    async function extractIntoRoot(project: ProjectShape) {
      execFileSync(
        PYTHON,
        [
          "-I",
          "-c",
          "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    z.writestr('index.php', 'x')\n    z.writestr('inc/a.php', 'x')",
          path.join(root, "site.zip"),
        ],
        { stdio: "pipe" },
      );
      await serviceFor(project).extract(OWNER, PROJECT_ID, "site.zip", ".");
    }

    it("never hands the project root over, even when extracting into it", async () => {
      await fs.mkdir(path.join(root, ".git"));
      await extractIntoRoot(PHP_NO_BUILD);

      expect(owned()).not.toContain("");
      expect(owned()).not.toContain(".");
      expect(owned()).not.toContain(".git");
      // What was extracted into it is still handed over.
      expect(owned()).toContain("index.php");
      expect(owned()).toContain("inc/a.php");
    });

    it("still hands the root of a plain no-build project over when extracting into it", async () => {
      await extractIntoRoot(PHP_NO_BUILD);

      expect(owned()).toContain("");
    });

    it("hands over a file created in a subfolder", async () => {
      await fs.mkdir(path.join(root, ".git"));
      await serviceFor(PHP_NO_BUILD).createFile(OWNER, PROJECT_ID, "app/a.php", "x");

      expect(owned()).toEqual(["app", "app/a.php"]);
    });

    it("leaves WordPress handling unchanged", async () => {
      await fs.mkdir(path.join(root, ".git"));
      await serviceFor({ type: "WORDPRESS", buildCmd: null }).createFile(OWNER, PROJECT_ID, "wp-content/a.php", "x");

      expect(owned()).toEqual(["wp-content", "wp-content/a.php"]);
    });
  });

  it("never hands over anything inside deploy/ or .git", async () => {
    const service = serviceFor(PHP_NO_BUILD);
    await service.createFile(OWNER, PROJECT_ID, "deploy/docker-compose.yml", "x");
    await service.createFile(OWNER, PROJECT_ID, ".git/config", "x");

    expect(owned()).toEqual([]);
  });

  it("leaves projects that do not run PHP-FPM alone", async () => {
    for (const project of [
      { type: "NODEJS", buildCmd: "npm run build" },
      { type: "PHP", buildCmd: "composer install" },
      { type: "STATIC", buildCmd: null },
    ]) {
      await serviceFor(project).createFile(OWNER, PROJECT_ID, `${project.type}.txt`, "x");
    }

    expect(owned()).toEqual([]);
  });

  it("limits WordPress to wp-content", async () => {
    const service = serviceFor({ type: "WORDPRESS", buildCmd: null });
    await service.createFile(OWNER, PROJECT_ID, "notes.txt", "x");
    await service.createFile(OWNER, PROJECT_ID, "wp-content/themes/t/style.css", "x");

    expect(owned()).toEqual(["wp-content", "wp-content/themes", "wp-content/themes/t", "wp-content/themes/t/style.css"]);
  });

  it("does nothing when the API is not root (development)", async () => {
    setUid(1000);
    await serviceFor(PHP_NO_BUILD).createFile(OWNER, PROJECT_ID, "a.php", "x");

    expect(lchown).not.toHaveBeenCalled();
  });

  it("keeps the saved file and logs when the ownership change is refused", async () => {
    lchown.mockRejectedValue(Object.assign(new Error("not permitted"), { code: "EPERM" }));

    await serviceFor(PHP_NO_BUILD).createFile(OWNER, PROJECT_ID, "a.php", "x");

    expect(await fs.readFile(path.join(root, "a.php"), "utf-8")).toBe("x");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("still denies another user's project", async () => {
    await expect(
      serviceFor(PHP_NO_BUILD).createFile("intruder", PROJECT_ID, "a.php", "x"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(lchown).not.toHaveBeenCalled();
  });
});
