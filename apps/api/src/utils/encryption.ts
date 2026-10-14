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
function getEncryptionKey(): Buffer {
  const secret = env.ENCRYPTION_KEY ?? env.SESSION_SECRET;
  return createHash("sha256").update(secret).digest();
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

/**
 * Decrypts an AES-256-GCM ciphertext string.
 * Verifies authenticity via the GCM auth tag before returning plaintext.
 *
 * @param cipherText - Serialized string in `ivHex:authTagHex:encryptedHex` format
 * @returns Original plaintext string
 * @throws EncryptionError if format is invalid or ciphertext fails authentication
 */
export function decrypt(cipherText: string): string {
  try {
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

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new EncryptionError(
        "Invalid IV or Auth Tag length",
        "INVALID_CIPHERTEXT_METADATA",
      );
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    if (err instanceof EncryptionError) throw err;
    throw new EncryptionError(
      "Failed to decrypt data: Authentication tag verification failed or data is corrupted",
      "DECRYPT_FAILED",
    );
  }
}

/**
 * Returns a masked representation of an environment variable value for UI display.
 */
export function maskValue(_value?: string): string {
  return "••••••••";
}

