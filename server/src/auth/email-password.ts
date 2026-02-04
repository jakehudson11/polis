/**
 * Email/Password Authentication
 * 
 * Provides email/password registration and login functionality
 * Issues OIDC-compatible JWT tokens for integration with existing auth system
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Config from "../config";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import { getPrivateKey } from "./jwt-utils";

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRATION_SECONDS = 365 * 24 * 60 * 60; // 1 year

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Get user by email
 */
export async function getUserByEmail(
  email: string
): Promise<{ uid: number; email: string; hname: string; username: string; is_owner: boolean } | null> {
  try {
    const rows = await pg.queryP_readOnly<{
      uid: number;
      email: string;
      hname: string;
      username: string;
      is_owner: boolean;
    }>("SELECT uid, email, hname, username, is_owner FROM users WHERE email = $1 LIMIT 1;", [
      email,
    ]);
    
    if (rows && Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }
    return null;
  } catch (error) {
    logger.error("Error getting user by email:", error);
    throw error;
  }
}

/**
 * Get password hash for a user
 */
export async function getPasswordHash(uid: number): Promise<string | null> {
  try {
    const rows = await pg.queryP_readOnly<{ pwhash: string }>(
      "SELECT pwhash FROM jianiuevyew WHERE uid = $1 LIMIT 1;",
      [uid]
    );
    
    if (rows && Array.isArray(rows) && rows.length > 0) {
      return rows[0].pwhash;
    }
    return null;
  } catch (error) {
    logger.error("Error getting password hash:", error);
    throw error;
  }
}

/**
 * Create a new user with email and password
 */
export async function createUserWithPassword(
  email: string,
  password: string,
  name?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    pg.query("BEGIN", [], (beginErr: any) => {
      if (beginErr) {
        logger.error("Failed to begin transaction:", beginErr);
        return reject(beginErr);
      }

      // Generate username from email if not provided
      const username = name ? name.toLowerCase().replace(/\s+/g, "_") : email.split("@")[0];

      // Insert user
      pg.query(
        "INSERT INTO users (email, hname, username, is_owner, created) VALUES ($1, $2, $3, $4, now_as_millis()) RETURNING uid;",
        [email, name || "", username, true], // is_owner = true for email/password users
        async (userErr: any, userResult: { rows: { uid: number }[] }) => {
          if (userErr) {
            // Check if it's a duplicate email error
            if (userErr.code === "23505") {
              return pg.query("ROLLBACK", [], () => {
                reject(new Error("Email already registered"));
              });
            }
            return pg.query("ROLLBACK", [], () => reject(userErr));
          }

          if (!userResult.rows || !userResult.rows.length) {
            return pg.query("ROLLBACK", [], () => {
              reject(new Error("Failed to create user"));
            });
          }

          const uid = userResult.rows[0].uid;

          // Hash password
          try {
            const passwordHash = await hashPassword(password);

            // Insert password hash
            pg.query(
              "INSERT INTO jianiuevyew (uid, pwhash) VALUES ($1, $2);",
              [uid, passwordHash],
              (pwdErr: any) => {
                if (pwdErr) {
                  return pg.query("ROLLBACK", [], () => reject(pwdErr));
                }

                // Commit transaction
                pg.query("COMMIT", [], (commitErr: any) => {
                  if (commitErr) return reject(commitErr);
                  resolve(uid);
                });
              }
            );
          } catch (hashError) {
            return pg.query("ROLLBACK", [], () => reject(hashError));
          }
        }
      );
    });
  });
}

/**
 * Update password for a user
 */
export async function updatePassword(
  uid: number,
  newPassword: string
): Promise<void> {
  try {
    const passwordHash = await hashPassword(newPassword);

    // Update or insert password hash
    await pg.queryP(
      "INSERT INTO jianiuevyew (uid, pwhash) VALUES ($1, $2) ON CONFLICT (uid) DO UPDATE SET pwhash = $2;",
      [uid, passwordHash]
    );
  } catch (error) {
    logger.error("Error updating password:", error);
    throw error;
  }
}

/**
 * Issue OIDC-compatible JWT token for email/password users
 * Uses our own private key but matches OIDC token format
 */
export function issueEmailPasswordJWT(
  uid: number,
  email: string,
  name?: string
): string {
  const privateKey = getPrivateKey();
  
  // Create OIDC-compatible payload
  // Use email-based sub to distinguish from OIDC users
  const sub = `email|${email}`;
  
  const payload = {
    sub,
    aud: Config.authAudience as string,
    iss: Config.authIssuer as string,
    email,
    email_verified: false, // Can be verified later via email verification
    name: name || email.split("@")[0],
    // Add custom claim to identify as email/password user
    [`${Config.authNamespace}email_password_user`]: true,
    [`${Config.authNamespace}uid`]: uid,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRATION_SECONDS,
  };

  try {
    return jwt.sign(payload, privateKey, { algorithm: "RS256" });
  } catch (error) {
    logger.error("Failed to sign email/password JWT:", error);
    throw new Error("Failed to create authentication token");
  }
}


