import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Constants & Key Derivation
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits standard for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Derives a deterministic 32-byte cryptographic key from the configured secret.
 * Uses SHA-256 to ensure exactly 32 bytes regardless of secret input length.
 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function getEncryptionKey(): Buffer {
  return deriveKey(env.ENCRYPTION_KEY ?? env.SESSION_SECRET);
}

/**
 * Key derived from SESSION_SECRET, which installs without ENCRYPTION_KEY used
 * to encrypt under (#69). Only offered for decryption, and only while
 * ENCRYPTION_KEY_LEGACY_FALLBACK is on and a dedicated key is configured —
 * otherwise it already *is* the primary key.
 */
function getLegacyKey(): Buffer | null {
  if (!env.ENCRYPTION_KEY || !env.ENCRYPTION_KEY_LEGACY_FALLBACK) return null;
  return deriveKey(env.SESSION_SECRET);
}

/** Boot-time diagnostics for how at-rest encryption is configured. */
export function getEncryptionKeyWarnings(): string[] {
  const warnings: string[] = [];
  if (!env.ENCRYPTION_KEY) {
    warnings.push(
      "ENCRYPTION_KEY is not set: stored credentials are encrypted with a key derived from SESSION_SECRET, " +
        "so a leaked session secret exposes them and rotating it makes them undecryptable. Set ENCRYPTION_KEY.",
    );
  } else if (env.ENCRYPTION_KEY_LEGACY_FALLBACK) {
    warnings.push(
      "ENCRYPTION_KEY_LEGACY_FALLBACK is on: values encrypted under SESSION_SECRET are still readable. " +
        "Run `pnpm db:reencrypt`, then unset it.",
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Custom Error
// ---------------------------------------------------------------------------

export class EncryptionError extends Error {
  constructor(
    message: string,
    public code: string = "ENCRYPTION_ERROR",
  ) {
    super(message);
    this.name = "EncryptionError";
  }
}

// ---------------------------------------------------------------------------
// Encryption & Decryption Functions
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext string using AES-256-GCM authenticated encryption.
 * Generates a fresh random 12-byte IV for every encryption call.
 *
 * @param plainText - Plaintext string to encrypt
 * @returns Serialized format: `ivHex:authTagHex:encryptedHex`
 */
export function encrypt(plainText: string): string {
  try {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    let encrypted = cipher.update(plainText, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (err) {
    throw new EncryptionError(
      `Failed to encrypt data: ${err instanceof Error ? err.message : String(err)}`,
      "ENCRYPT_FAILED",
    );
  }
}

function decryptWithKey(key: Buffer, iv: Buffer, authTag: Buffer, encryptedHex: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Decrypts an AES-256-GCM ciphertext string and reports whether the legacy
 * (SESSION_SECRET-derived) key was needed — i.e. whether the value should be
 * re-encrypted under the current key.
 *
 * @param cipherText - Serialized string in `ivHex:authTagHex:encryptedHex` format
 * @throws EncryptionError if format is invalid or ciphertext fails authentication
 */
export function decryptWithMeta(cipherText: string): { plainText: string; legacy: boolean } {
  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    throw new EncryptionError(
      "Invalid encrypted data format. Expected iv:authTag:ciphertext",
      "INVALID_CIPHERTEXT_FORMAT",
    );
  }

  const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];
  // The ciphertext part is legitimately empty for an empty plaintext (GCM
  // still emits an auth tag, which is verified below), so only the IV and
  // tag are required to be present.
  if (!ivHex || !authTagHex) {
    throw new EncryptionError(
      "Malformed encrypted payload parts",
      "INVALID_CIPHERTEXT_PARTS",
    );
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new EncryptionError(
      "Invalid IV or Auth Tag length",
      "INVALID_CIPHERTEXT_METADATA",
    );
  }

  try {
    return {
      plainText: decryptWithKey(getEncryptionKey(), iv, authTag, encryptedHex),
      legacy: false,
    };
  } catch {
    const legacyKey = getLegacyKey();
    if (legacyKey) {
      try {
        return {
          plainText: decryptWithKey(legacyKey, iv, authTag, encryptedHex),
          legacy: true,
        };
      } catch {
        // fall through to the generic failure below
      }
    }
    throw new EncryptionError(
      "Failed to decrypt data: Authentication tag verification failed or data is corrupted",
      "DECRYPT_FAILED",
    );
  }
}

/**
 * Decrypts an AES-256-GCM ciphertext string.
 * Verifies authenticity via the GCM auth tag before returning plaintext.
 *
 * @param cipherText - Serialized string in `ivHex:authTagHex:encryptedHex` format
 * @returns Original plaintext string
 * @throws EncryptionError if format is invalid or ciphertext fails authentication
 */
export function decrypt(cipherText: string): string {
  return decryptWithMeta(cipherText).plainText;
}

/**
 * Returns a masked representation of an environment variable value for UI display.
 */
export function maskValue(_value?: string): string {
  return "••••••••";
}

