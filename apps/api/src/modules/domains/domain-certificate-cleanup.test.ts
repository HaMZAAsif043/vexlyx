import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { DomainService } = await import("./service.js");
afterEach(() => vi.restoreAllMocks());

describe("domain deletion certificate cleanup (#195)", () => {
  function fixture() {
    const files = new Map<string, Buffer>();
    for (const [id, host] of [["d1", "example.com"], ["d2", "app.example.com"], ["d3", "deep.app.example.com"]]) {
      for (const suffix of ["crt", "key"]) {
        const material = Buffer.from(`${id}-${suffix}`);
        files.set(`domain-${id}.${suffix}`, material);
        files.set(`${host}.${suffix}`, material);
      }
    }
    vi.spyOn(fs, "existsSync").mockImplementation((file) => files.has(path.basename(String(file))));
    vi.spyOn(fs, "readFileSync").mockImplementation((file) => files.get(path.basename(String(file)))!);
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => { files.delete(path.basename(String(file))); });
    const prisma = { domain: {
      findFirst: vi.fn().mockResolvedValue({ id: "d1", hostname: "example.com", userId: "u1" }),
      findMany: vi.fn()
        .mockResolvedValueOnce([{ id: "d2", hostname: "app.example.com" }])
        .mockResolvedValueOnce([{ id: "d3", hostname: "deep.app.example.com" }])
        .mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    } };
    const service = new DomainService(prisma as unknown as PrismaClient);
    return { files, service, prisma };
  }

  it("removes both name pairs for the parent and every descendant", async () => {
    const { service, files, prisma } = fixture();
    await service.delete("u1", "d1");
    expect(files.size).toBe(0);
    expect(prisma.domain.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
  });

  it("preserves a convenience copy holding another domain's key", () => {
    const { service, files } = fixture();
    files.set("example.com.key", Buffer.from("another-domain"));
    service.removeTraefikRouter("d1", true, "example.com");
    expect(files.get("example.com.key")?.toString()).toBe("another-domain");
    expect(files.has("domain-d1.key")).toBe(false);
  });

  it("keeps the domain row for retry when certificate deletion is denied", async () => {
    const { service, prisma } = fixture();
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(service.delete("u1", "d1")).rejects.toMatchObject({ code: "CERTIFICATE_CLEANUP_FAILED" });
    expect(prisma.domain.delete).not.toHaveBeenCalled();
  });
});
