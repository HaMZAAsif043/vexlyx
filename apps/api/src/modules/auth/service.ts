import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { notifyUser } from "../system-email/notifier.js";
import type { RegisterInput, LoginInput, ChangePasswordInput } from "./schema.js";

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  resellerId: true,
  maxProjects: true,
  maxDomains: true,
  maxDatabases: true,
  maxMailboxes: true,
  maxSubAccounts: true,
  permissions: true,
  totpEnabled: true,
  createdAt: true,
} as const;

// Security: an unknown email must cost as much as a wrong password, otherwise
// response time reveals which emails are registered. The decoy is hashed with
// the same options as real passwords (register/changePassword use the argon2
// defaults with argon2id) so verify() does equivalent work. Its plaintext is
// random and discarded, so no login can ever match it. Memoised so the hash is
// computed once per process rather than on every failed login.
let decoyHash: Promise<string> | null = null;

function getDecoyHash(): Promise<string> {
  decoyHash ??= argon2
    .hash(randomBytes(32).toString("hex"), { type: argon2.argon2id })
    .catch((err: unknown) => {
      decoyHash = null;
      throw err;
    });
  return decoyHash;
}

/**
 * Computes the decoy hash ahead of time. Called once at startup, before the
 * auth routes accept requests, so even the very first failed login does the
 * same work whether or not the email exists.
 */
export async function prepareLoginDecoy(): Promise<void> {
  await getDecoyHash();
}

export class AuthService {
  constructor(private prisma: PrismaClient) {}

  async register(data: RegisterInput) {
    const existing = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existing) {
      throw new AuthError("Email already registered", "EMAIL_EXISTS", 409);
    }

    const hashedPassword = await argon2.hash(data.password, {
      type: argon2.argon2id,
    });

    // Auto-promote to ADMIN if this is the first user in the system
    const userCount = await this.prisma.user.count();
    const role = userCount === 0 ? "ADMIN" : "USER";

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: hashedPassword,
        role,
      },
      select: PUBLIC_USER_SELECT,
    });

    return user;
  }

  async login(data: LoginInput) {
    const user = await this.prisma.user.findUnique({
      where: { email: data.email },
    });

    if (!user) {
      await argon2.verify(await getDecoyHash(), data.password);
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    const validPassword = await argon2.verify(user.password, data.password);

    if (!validPassword) {
      throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS", 401);
    }

    return this.getCurrentUser(user.id);
  }

  // F5.11 — self-service password change. The current session stays valid;
  // only the stored hash changes, so the old password simply stops working
  // (including for anyone else's sessions, since login re-verifies on the
  // fly rather than caching a password check).
  async changePassword(userId: string, data: ChangePasswordInput) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    }

    const validPassword = await argon2.verify(user.password, data.currentPassword);
    if (!validPassword) {
      throw new AuthError("Current password is incorrect", "INVALID_CREDENTIALS", 401);
    }

    const hashedPassword = await argon2.hash(data.newPassword, {
      type: argon2.argon2id,
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    notifyUser("password_changed", user.email, { name: user.name });
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });

    if (!user) {
      throw new AuthError("User not found", "USER_NOT_FOUND", 404);
    }

    return user;
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
