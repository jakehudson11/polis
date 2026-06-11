import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const KEY_MIN_LENGTH = 32; // AES-256 requires a 32-byte key

function getEncryptionKey(): Buffer {
  const key = process.env.POLIS_DB_ENCRYPTION_KEY;

  if (!key || key.length < KEY_MIN_LENGTH) {
    throw new Error(
      'POLIS_DB_ENCRYPTION_KEY is not set or is too short. ' +
      'AES-256-GCM requires at least a 32-byte (32 character) encryption key. ' +
      'Set the POLIS_DB_ENCRYPTION_KEY environment variable and restart.'
    );
  }

  // Use exactly the first 32 bytes for AES-256
  return Buffer.from(key.slice(0, 32), 'utf8');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * Each call generates a fresh random 12-byte IV.
 * Returns a colon-separated string: base64(iv):base64(ciphertext):base64(authTag)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    encrypted.toString('base64'),
    authTag.toString('base64'),
  ].join(':');
}

/**
 * Decrypts a ciphertext string produced by `encrypt()`.
 *
 * Expects the format: base64(iv):base64(ciphertext):base64(authTag)
 * Throws if the ciphertext is malformed, has been tampered with, or was
 * encrypted with a different key.
 */
export function decrypt(ciphertext: string): string {
  if (typeof ciphertext !== 'string' || ciphertext.trim().length === 0) {
    throw new Error('decrypt: ciphertext must be a non-empty string');
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'decrypt: malformed ciphertext. Expected format: base64(iv):base64(ciphertext):base64(authTag)'
    );
  }

  const [ivB64, encryptedB64, authTagB64] = parts;
  if (!ivB64 || !encryptedB64 || !authTagB64) {
    throw new Error(
      'decrypt: ciphertext parts must not be empty. Expected format: base64(iv):base64(ciphertext):base64(authTag)'
    );
  }

  let iv: Buffer;
  let encrypted: Buffer;
  let authTag: Buffer;

  try {
    iv = Buffer.from(ivB64, 'base64');
    encrypted = Buffer.from(encryptedB64, 'base64');
    authTag = Buffer.from(authTagB64, 'base64');
  } catch {
    throw new Error(
      'decrypt: failed to decode ciphertext components from base64. ' +
      'The ciphertext may be corrupted or malformed.'
    );
  }

  if (iv.length !== IV_LENGTH) {
    throw new Error(
      `decrypt: invalid IV length (got ${iv.length} bytes, expected ${IV_LENGTH}). ` +
      'The ciphertext may be corrupted or was not produced by this module.'
    );
  }

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `decrypt: invalid auth tag length (got ${authTag.length} bytes, expected ${AUTH_TAG_LENGTH}). ` +
      'The ciphertext may be corrupted or was not produced by this module.'
    );
  }

  const key = getEncryptionKey();

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err: any) {
    const message = err?.message || String(err);
    throw new Error(
      `decrypt: decryption failed — ${message}. ` +
      'The ciphertext may have been tampered with, or it was encrypted with a different key.'
    );
  }
}
