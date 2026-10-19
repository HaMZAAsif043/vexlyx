import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";
import { UserService } from "./service.js";

type Target = { id: string; email: string; role: string; resellerId: string | null };

function fixture(target: Target, revokeSessions = vi.fn().mockResolvedValue(undefined)) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(target),
      delete: vi.fn().mockResolvedValue(target),
    },
  };
  const auditLog = { log: vi.fn() };
  const onUserDeleted = vi.fn();
  const service = new UserService(
    prisma as unknown as PrismaClient,
    auditLog as unknown as AuditLogService,
    onUserDeleted,
    revokeSessions,
  );
  return { prisma, auditLog, service, revokeSessions };
}

const USER: Target = { id: "u2", email: "u2@example.com", role: "USER", resellerId: null };
const ADMIN = { id: "admin-1", role: "ADMIN" as const };

describe("UserService.delete ends the deleted user's sessions", () => {
  it("revokes their sessions before the row (and its session rows) is deleted", async () => {
    const { prisma, service, revokeSessions } = fixture(USER);

    await service.delete(ADMIN, "u2");

    expect(revokeSessions).toHaveBeenCalledWith("u2");
    const revokedAt = revokeSessions.mock.invocationCallOrder[0] ?? Infinity;
    const deletedAt = prisma.user.delete.mock.invocationCallOrder[0] ?? 0;
    expect(revokedAt).toBeLessThan(deletedAt);
  });

  it("keeps the user and writes no audit entry when revocation fails, so the admin can retry", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const { prisma, auditLog, service } = fixture(USER, failing);

    await expect(service.delete(ADMIN, "u2")).rejects.toThrow("redis unavailable");

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("revokes the sessions of a sub-account when its reseller deletes it", async () => {
    const sub: Target = { id: "sub-1", email: "sub@example.com", role: "USER", resellerId: "reseller-1" };
    const { service, revokeSessions } = fixture(sub);

    await service.delete({ id: "reseller-1", role: "RESELLER" }, "sub-1");

    expect(revokeSessions).toHaveBeenCalledWith("sub-1");
  });

  it("does not touch any session when the requester may not delete the target", async () => {
    const other: Target = { id: "u3", email: "u3@example.com", role: "USER", resellerId: "someone-else" };
    const { prisma, service, revokeSessions } = fixture(other);

    await expect(service.delete({ id: "reseller-1", role: "RESELLER" }, "u3")).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });

    expect(revokeSessions).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it("never revokes anything when an admin tries to delete their own account", async () => {
    const { service, revokeSessions } = fixture({ ...USER, id: ADMIN.id });

    await expect(service.delete(ADMIN, ADMIN.id)).rejects.toMatchObject({ code: "CANNOT_DELETE_SELF" });

    expect(revokeSessions).not.toHaveBeenCalled();
  });
});
