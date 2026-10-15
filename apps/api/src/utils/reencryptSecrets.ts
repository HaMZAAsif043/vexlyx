import type { PrismaClient } from "@prisma/client";
import { decryptWithMeta, encrypt } from "./encryption.js";

export interface ReencryptResult {
  migrated: number;
  current: number;
  unreadable: string[];
}

interface Column {
  label: string;
  load: () => Promise<Array<{ id: string; value: string | null }>>;
  save: (id: string, value: string) => Promise<unknown>;
}

function buildColumns(prisma: PrismaClient): Column[] {
  return [
    {
      label: "User.totpSecretEncrypted",
      load: async () =>
        (
          await prisma.user.findMany({
            select: { id: true, totpSecretEncrypted: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.totpSecretEncrypted,
        })),
      save: (id, value) =>
        prisma.user.update({
          where: { id },
          data: { totpSecretEncrypted: value },
        }),
    },
    {
      label: "Database.dbPassword",
      load: async () =>
        (
          await prisma.database.findMany({
            select: { id: true, dbPassword: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.dbPassword,
        })),
      save: (id, value) =>
        prisma.database.update({ where: { id }, data: { dbPassword: value } }),
    },
    {
      label: "Certificate.encryptedKey",
      load: async () =>
        (
          await prisma.certificate.findMany({
            select: { id: true, encryptedKey: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.encryptedKey,
        })),
      save: (id, value) =>
        prisma.certificate.update({
          where: { id },
          data: { encryptedKey: value },
        }),
    },
    {
      label: "EnvVar.value",
      load: async () =>
        (
          await prisma.envVar.findMany({ select: { id: true, value: true } })
        ).map((r) => ({
          id: r.id,
          value: r.value,
        })),
      save: (id, value) =>
        prisma.envVar.update({ where: { id }, data: { value } }),
    },
    {
      label: "SftpUser.encryptedPassword",
      load: async () =>
        (
          await prisma.sftpUser.findMany({
            select: { id: true, encryptedPassword: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.encryptedPassword,
        })),
      save: (id, value) =>
        prisma.sftpUser.update({
          where: { id },
          data: { encryptedPassword: value },
        }),
    },
    {
      label: "GitHubApp.encryptedClientSecret",
      load: async () =>
        (
          await prisma.gitHubApp.findMany({
            select: { id: true, encryptedClientSecret: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.encryptedClientSecret,
        })),
      save: (id, value) =>
        prisma.gitHubApp.update({
          where: { id },
          data: { encryptedClientSecret: value },
        }),
    },
    {
      label: "GitHubApp.encryptedPrivateKey",
      load: async () =>
        (
          await prisma.gitHubApp.findMany({
            select: { id: true, encryptedPrivateKey: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.encryptedPrivateKey,
        })),
      save: (id, value) =>
        prisma.gitHubApp.update({
          where: { id },
          data: { encryptedPrivateKey: value },
        }),
    },
    {
      label: "GitHubApp.encryptedWebhookSecret",
      load: async () =>
        (
          await prisma.gitHubApp.findMany({
            select: { id: true, encryptedWebhookSecret: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.encryptedWebhookSecret,
        })),
      save: (id, value) =>
        prisma.gitHubApp.update({
          where: { id },
          data: { encryptedWebhookSecret: value },
        }),
    },
  ];
}

/**
 * Re-encrypts every value that is only readable through the legacy
 * SESSION_SECRET-derived key under the current ENCRYPTION_KEY (#69).
 * Idempotent; a value that cannot be decrypted is reported, never changed.
 */
export async function reencryptSecrets(
  prisma: PrismaClient,
  options: { dryRun?: boolean } = {},
): Promise<ReencryptResult> {
  const result: ReencryptResult = { migrated: 0, current: 0, unreadable: [] };

  for (const column of buildColumns(prisma)) {
    for (const row of await column.load()) {
      if (!row.value) continue;
      try {
        const { plainText, legacy } = decryptWithMeta(row.value);
        if (!legacy) {
          result.current += 1;
          continue;
        }
        if (!options.dryRun) await column.save(row.id, encrypt(plainText));
        result.migrated += 1;
      } catch {
        result.unreadable.push(`${column.label} ${row.id}`);
      }
    }
  }

  return result;
}
