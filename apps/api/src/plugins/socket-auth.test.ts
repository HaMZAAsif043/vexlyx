import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  SubscriptionGate,
  authorizeSocketSubscription,
  createSocketAuthorizer,
  type SocketAuthorizer,
} from "./socket-auth.js";

function prismaWith(user: { role: string; permissions: string[] } | null | Error) {
  const findUnique = vi.fn(async () => {
    if (user instanceof Error) throw user;
    return user;
  });
  return {
    prisma: { user: { findUnique } } as unknown as PrismaClient,
    findUnique,
  };
}

const logger = () => ({ error: vi.fn() });

describe("createSocketAuthorizer (#65)", () => {
  it("allows a user whose role is listed", async () => {
    const { prisma } = prismaWith({ role: "ADMIN", permissions: [] });

    await expect(
      createSocketAuthorizer(prisma, logger())("u1", { roles: ["ADMIN"] }),
    ).resolves.toBe(true);
  });

  it.each(["USER", "RESELLER"])("denies a %s when only ADMIN is allowed", async (role) => {
    const { prisma } = prismaWith({ role, permissions: [] });

    await expect(
      createSocketAuthorizer(prisma, logger())("u1", { roles: ["ADMIN"] }),
    ).resolves.toBe(false);
  });

  it("allows a non-admin who was granted the permission (additive, like requireRoleOrPermission)", async () => {
    const { prisma } = prismaWith({ role: "USER", permissions: ["canManageBackups"] });

    await expect(
      createSocketAuthorizer(prisma, logger())("u1", {
        roles: ["ADMIN"],
        permission: "canManageBackups",
      }),
    ).resolves.toBe(true);
  });

  it("denies a non-admin without the permission", async () => {
    const { prisma } = prismaWith({ role: "USER", permissions: ["canManageFirewall"] });

    await expect(
      createSocketAuthorizer(prisma, logger())("u1", {
        roles: ["ADMIN"],
        permission: "canManageBackups",
      }),
    ).resolves.toBe(false);
  });

  it("ignores a permission when the rule does not name one", async () => {
    const { prisma } = prismaWith({ role: "USER", permissions: ["canManageBackups"] });

    await expect(
      createSocketAuthorizer(prisma, logger())("u1", { roles: ["ADMIN"] }),
    ).resolves.toBe(false);
  });

  it("denies without querying when there is no identity", async () => {
    const { prisma, findUnique } = prismaWith({ role: "ADMIN", permissions: [] });

    await expect(
      createSocketAuthorizer(prisma, logger())(undefined, { roles: ["ADMIN"] }),
    ).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("denies a user that no longer exists", async () => {
    const { prisma } = prismaWith(null);

    await expect(
      createSocketAuthorizer(prisma, logger())("ghost", { roles: ["ADMIN"] }),
    ).resolves.toBe(false);
  });

  it("fails closed and logs when the lookup throws", async () => {
    const { prisma } = prismaWith(new Error("db down"));
    const log = logger();

    await expect(createSocketAuthorizer(prisma, log)("u1", { roles: ["ADMIN"] })).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("reads the role fresh on every call so a revocation applies to the next subscribe", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ role: "ADMIN", permissions: [] })
      .mockResolvedValueOnce({ role: "USER", permissions: [] });
    const authorize = createSocketAuthorizer(
      { user: { findUnique } } as unknown as PrismaClient,
      logger(),
    );

    await expect(authorize("u1", { roles: ["ADMIN"] })).resolves.toBe(true);
    await expect(authorize("u1", { roles: ["ADMIN"] })).resolves.toBe(false);
  });
});

describe("authorizeSocketSubscription", () => {
  function socket(userId?: string) {
    return { data: { userId }, emit: vi.fn() };
  }

  it("returns true and emits nothing when authorized", async () => {
    const authorize: SocketAuthorizer = vi.fn(async () => true);
    const s = socket("u1");

    await expect(
      authorizeSocketSubscription(authorize, s, { roles: ["ADMIN"] }, "room:forbidden"),
    ).resolves.toBe(true);
    expect(s.emit).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith("u1", { roles: ["ADMIN"] });
  });

  it("returns false and emits the denial event when not authorized", async () => {
    const authorize: SocketAuthorizer = vi.fn(async () => false);
    const s = socket("u1");

    await expect(
      authorizeSocketSubscription(authorize, s, { roles: ["ADMIN"] }, "room:forbidden"),
    ).resolves.toBe(false);
    expect(s.emit).toHaveBeenCalledWith(
      "room:forbidden",
      expect.objectContaining({ code: "FORBIDDEN_ROLE" }),
    );
  });
});

describe("SubscriptionGate", () => {
  it("treats the latest begin() token as current", () => {
    const gate = new SubscriptionGate();

    const token = gate.begin();

    expect(gate.isCurrent(token)).toBe(true);
  });

  it("invalidates outstanding tokens on cancel()", () => {
    const gate = new SubscriptionGate();
    const token = gate.begin();

    gate.cancel();

    expect(gate.isCurrent(token)).toBe(false);
  });

  it("lets a newer subscribe supersede an older pending one", () => {
    const gate = new SubscriptionGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("is independent per instance (one gate per socket)", () => {
    const a = new SubscriptionGate();
    const b = new SubscriptionGate();
    const token = a.begin();

    b.cancel();

    expect(a.isCurrent(token)).toBe(true);
  });
});
