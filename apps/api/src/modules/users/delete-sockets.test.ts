import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AuditLogService } from "../audit-log/service.js";
import { UserService } from "./service.js";

function fixture(target: { id: string; email: string; role: string; resellerId: string | null }) {
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
  );
  return { prisma, service, onUserDeleted };
}

const ADMIN = { id: "admin-1", role: "ADMIN" as const };

describe("UserService.delete ends the user's live sockets (#64)", () => {
  it("notifies after the row is deleted so their connections can be closed", async () => {
    const { prisma, service, onUserDeleted } = fixture({
      id: "u2",
      email: "u2@example.com",
      role: "USER",
      resellerId: null,
    });

    await service.delete(ADMIN, "u2");

    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: "u2" } });
    expect(onUserDeleted).toHaveBeenCalledTimes(1);
    expect(onUserDeleted).toHaveBeenCalledWith("u2");
  });

  it("does not notify when deleting yourself is refused", async () => {
    const { prisma, service, onUserDeleted } = fixture({
      id: "admin-1",
      email: "a@example.com",
      role: "ADMIN",
      resellerId: null,
    });

    await expect(service.delete(ADMIN, "admin-1")).rejects.toMatchObject({
      code: "CANNOT_DELETE_SELF",
    });

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(onUserDeleted).not.toHaveBeenCalled();
  });

  it("does not notify when a reseller tries to delete someone else's account", async () => {
    const { prisma, service, onUserDeleted } = fixture({
      id: "u3",
      email: "u3@example.com",
      role: "USER",
      resellerId: "other",
    });

    await expect(
      service.delete({ id: "reseller-1", role: "RESELLER" }, "u3"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(onUserDeleted).not.toHaveBeenCalled();
  });

  it("still deletes when no callback was provided", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "u2", email: "u2@example.com", role: "USER", resellerId: null }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    const service = new UserService(
      prisma as unknown as PrismaClient,
      { log: vi.fn() } as unknown as AuditLogService,
    );

    await expect(service.delete(ADMIN, "u2")).resolves.toBeUndefined();
    expect(prisma.user.delete).toHaveBeenCalledTimes(1);
  });
});
