import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

/** A stream that delivers `first`, then fails the way an aborted request does. */
function abortingStream(first: string): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
        return;
      }
      this.destroy(new Error("aborted"));
    },
  });
}

/** What @fastify/multipart does when the part exceeds the size limit. */
function truncatedStream(content: string): Readable & { truncated: boolean } {
  const stream = Readable.from([content]) as Readable & { truncated: boolean };
  stream.truncated = true;
  return stream;
}

describe("FileService.writeUploadStream", () => {
  let sandbox: string;
  let root: string;
  let service: FileService;

  beforeAll(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vexlyx-upload-")));
    state.projectsDir = path.join(sandbox, "projects");
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = path.join(state.projectsDir, PROJECT_ID);
    await fs.rm(state.projectsDir, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });

    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: PROJECT_ID, userId: OWNER, deletedAt: null }),
      },
    } as unknown as PrismaClient;
    service = new FileService(prisma, { log: vi.fn() } as never);
  });

  it("stores the uploaded content and leaves no temporary file", async () => {
    await service.writeUploadStream(OWNER, PROJECT_ID, "docs/a.txt", Readable.from(["hel", "lo"]));

    expect(await fs.readFile(path.join(root, "docs", "a.txt"), "utf-8")).toBe("hello");
    expect(await fs.readdir(path.join(root, "docs"))).toEqual(["a.txt"]);
  });

  it("leaves nothing behind when the upload is aborted, so a retry is not a 409", async () => {
    await expect(
      service.writeUploadStream(OWNER, PROJECT_ID, "big.bin", abortingStream("partial")),
    ).rejects.toThrow("aborted");

    expect(await fs.readdir(root)).toEqual([]);

    await service.writeUploadStream(OWNER, PROJECT_ID, "big.bin", Readable.from(["whole"]));
    expect(await fs.readFile(path.join(root, "big.bin"), "utf-8")).toBe("whole");
  });

  it("rejects a part cut off by the size limit and keeps nothing", async () => {
    await expect(
      service.writeUploadStream(OWNER, PROJECT_ID, "huge.bin", truncatedStream("cut")),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE", statusCode: 413 });

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("keeps the original when an overwrite is aborted", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "original");

    await expect(
      service.writeUploadStream(OWNER, PROJECT_ID, "a.txt", abortingStream("new"), true),
    ).rejects.toThrow("aborted");

    expect(await fs.readFile(path.join(root, "a.txt"), "utf-8")).toBe("original");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  it("replaces the file when overwrite succeeds", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "original");

    await service.writeUploadStream(OWNER, PROJECT_ID, "a.txt", Readable.from(["new"]), true);

    expect(await fs.readFile(path.join(root, "a.txt"), "utf-8")).toBe("new");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  it("refuses to overwrite without the flag and keeps the original", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "original");

    await expect(
      service.writeUploadStream(OWNER, PROJECT_ID, "a.txt", Readable.from(["new"])),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS", statusCode: 409 });

    expect(await fs.readFile(path.join(root, "a.txt"), "utf-8")).toBe("original");
  });

  it("hides an in-progress upload from directory listings", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new Readable({
      async read() {
        this.push("part-one");
        await gate;
        this.push(null);
      },
    });

    const upload = service.writeUploadStream(OWNER, PROJECT_ID, "slow.bin", slow);
    await vi.waitFor(async () => {
      expect((await fs.readdir(root)).length).toBe(1);
    });

    expect(await service.listDir(OWNER, PROJECT_ID, "")).toEqual([]);

    release();
    await upload;
    expect((await service.listDir(OWNER, PROJECT_ID, "")).map((n) => n.name)).toEqual(["slow.bin"]);
  });

  it("denies another user's project", async () => {
    await expect(
      service.writeUploadStream("intruder", PROJECT_ID, "a.txt", Readable.from(["x"])),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    expect(await fs.readdir(root)).toEqual([]);
  });
});
