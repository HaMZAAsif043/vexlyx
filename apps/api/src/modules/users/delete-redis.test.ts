import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";
import { UserService } from "./service.js";

type Target = { id: string; email: string; role: string; resellerId: string | null };

function fixture(target: Target, teardownRedisInstances = vi.fn().mockResolvedValue(undefined)) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(target),
      delete: vi.fn().mockResolvedValue(target),
    },
  };
  const auditLog = { log: vi.fn() };
  const service = new UserService(
    prisma as unknown as PrismaClient,
    auditLog as unknown as AuditLogService,
    vi.fn(),
    vi.fn().mockResolvedValue(undefined),
    teardownRedisInstances,
  );
  return { prisma, auditLog, service, teardownRedisInstances };
}

const USER: Target = { id: "u2", email: "u2@example.com", role: "USER", resellerId: null };
const ADMIN = { id: "admin-1", role: "ADMIN" as const };

describe("UserService.delete tears down the user's Redis instances", () => {
  it("tears down the instance resources before the row (and its cascaded records) is deleted", async () => {
    const { prisma, service, teardownRedisInstances } = fixture(USER);

    await service.delete(ADMIN, "u2");

    expect(teardownRedisInstances).toHaveBeenCalledWith("u2");
    const tornDownAt = teardownRedisInstances.mock.invocationCallOrder[0] ?? Infinity;
    const deletedAt = prisma.user.delete.mock.invocationCallOrder[0] ?? 0;
    expect(tornDownAt).toBeLessThan(deletedAt);
  });

  it("keeps the user and writes no audit entry when teardown fails, so the admin can retry", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("docker unavailable"));
    const { prisma, auditLog, service } = fixture(USER, failing);

    await expect(service.delete(ADMIN, "u2")).rejects.toThrow("docker unavailable");

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });
});
