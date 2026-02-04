import crypto from "crypto";
import Config from "../config";
import logger from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 16 bytes for AES
const AUTH_TAG_LENGTH = 16; // 16 bytes for GCM auth tag
const SALT_LENGTH = 32; // 32 bytes for salt

/**
 * Encrypts an OAuth token using AES-256-GCM
 * Returns a string format: "iv:authTag:encryptedData" (all base64 encoded)
 */
export function encryptToken(token: string): string {
  if (!Config.meetingOAuthEncryptionKey) {
    throw new Error("MEETING_OAUTH_ENCRYPTION_KEY is not configured");
  }

  try {
    // Derive a 32-byte key from the encryption key
    const key = crypto
      .createHash("sha256")
      .update(Config.meetingOAuthEncryptionKey)
      .digest();

    // Generate random IV
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the token
    let encrypted = cipher.update(token, "utf8", "base64");
    encrypted += cipher.final("base64");

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Return format: "iv:authTag:encryptedData" (all base64)
    return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
  } catch (error) {
    logger.error("Error encrypting token", error);
    throw new Error("Failed to encrypt token");
  }
}

/**
 * Decrypts an OAuth token using AES-256-GCM
 * Expects format: "iv:authTag:encryptedData" (all base64 encoded)
 */
export function decryptToken(encryptedToken: string): string {
  if (!Config.meetingOAuthEncryptionKey) {
    throw new Error("MEETING_OAUTH_ENCRYPTION_KEY is not configured");
  }

  try {
    // Parse the encrypted token format: "iv:authTag:encryptedData"
    const parts = encryptedToken.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted token format");
    }

    const [ivBase64, authTagBase64, encryptedData] = parts;

    // Decode base64 components
    const iv = Buffer.from(ivBase64, "base64");
    const authTag = Buffer.from(authTagBase64, "base64");
    const encrypted = Buffer.from(encryptedData, "base64");

    // Derive the same key
    const key = crypto
      .createHash("sha256")
      .update(Config.meetingOAuthEncryptionKey)
      .digest();

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(encrypted, undefined, "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    logger.error("Error decrypting token", error);
    throw new Error("Failed to decrypt token");
  }
}



