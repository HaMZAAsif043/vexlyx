import { expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
  process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
});
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { WordPressService } from "./service.js";

it.each(["install", "export", "import", "upload", "status"])("rejects a custom source before WordPress %s can use the wrong tree", async operation => {
  const prisma = { project: { findUnique: vi.fn().mockResolvedValue({ id: "p1", userId: "u1", type: "WORDPRESS", deletedAt: null, baseDirectory: "blog" }) } };
  const service = new WordPressService(prisma as never);
  const call = operation === "install" ? service.install("u1", "p1", {} as never)
    : operation === "export" ? service.exportSite("u1", "p1")
    : operation === "import" ? service.importSite("u1", "p1", {} as never)
    : operation === "upload" ? service.uploadAsset("u1", "p1", {} as never)
    : service.getStatus("u1", "p1");
  await expect(call).rejects.toMatchObject({ code: "WORDPRESS_BASE_DIRECTORY_UNSUPPORTED", statusCode: 422 });
  expect(spawn).not.toHaveBeenCalled();
});
