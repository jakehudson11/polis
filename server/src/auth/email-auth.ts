/**
 * Email/Password authentication handlers
 * Issues OIDC-compatible JWT tokens for email/password authenticated users
 */

import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import { failJson } from "../utils/fail";
import Config from "../config";
import { getPrivateKey } from "./jwt-utils";

const JWT_ALGORITHM = "RS256";
const JWT_EXPIRATION_SECONDS = 365 * 24 * 60 * 60; // 1 year

/**
 * Issue an OIDC-compatible JWT token for email/password authenticated users
 * This token can be used for admin operations like creating conversations
 */
function issueOidcCompatibleToken(
  uid: number,
  email: string,
  name?: string,
  role?: string
): string {
  if (!Config.authAudience || !Config.authIssuer) {
    throw new Error(
      "AUTH_AUDIENCE and AUTH_ISSUER must be configured for email/password authentication"
    );
  }

  const payload = {
    sub: `user:${uid}`, // OIDC sub claim
    aud: Config.authAudience,
    iss: Config.authIssuer,
    email: email,
    email_verified: true,
    name: name || email,
    ...(role && { [`${Config.authNamespace || ""}role`]: role }),
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRATION_SECONDS,
    iat: Math.floor(Date.now() / 1000),
  };

  try {
    const privateKey = getPrivateKey();
    return jwt.sign(payload, privateKey, { algorithm: JWT_ALGORITHM });
  } catch (error) {
    logger.error("Failed to sign OIDC-compatible JWT:", error);
    throw new Error("Failed to create authentication token");
  }
}

/**
 * POST /api/v3/auth/register
 * Register a new user with email and password
 */
export async function handle_POST_auth_register(
  req: Request,
  res: Response
) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({
        status: "error",
        error: "Email and password are required",
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({
        status: "error",
        error: "Password must be at least 8 characters long",
      });
      return;
    }

    // Check if user already exists
    const existingUser = (await pg.queryP(
      "SELECT uid FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    )) as { uid: number }[];

    if (existingUser.length > 0) {
      res.status(400).json({
        status: "error",
        error: "User with this email already exists",
      });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const newUser = (await pg.queryP(
      `INSERT INTO users (email, hname, username, is_owner, created) 
       VALUES ($1, $2, $3, $4, now_as_millis()) 
       RETURNING uid, email, hname, username, is_owner`,
      [
        email.toLowerCase().trim(),
        name || null,
        name || email.split("@")[0],
        true, // Allow users to create conversations
      ]
    )) as {
      uid: number;
      email: string;
      hname: string | null;
      username: string | null;
      is_owner: boolean;
    }[];

    const user = newUser[0];

    // Store password hash
    await pg.queryP(
      "INSERT INTO jianiuevyew (uid, pwhash) VALUES ($1, $2) ON CONFLICT (uid) DO UPDATE SET pwhash = EXCLUDED.pwhash",
      [user.uid, passwordHash]
    );

    // Issue OIDC-compatible token
    const token = issueOidcCompatibleToken(
      user.uid,
      user.email,
      user.hname || undefined,
      "admin" // Default role for registered users
    );

    res.status(201).json({
      status: "ok",
      user: {
        uid: user.uid,
        email: user.email,
        name: user.hname || user.email,
        role: "admin",
        email_verified: false, // Email verification can be added later
      },
      auth: {
        token,
        token_type: "Bearer",
        expires_in: JWT_EXPIRATION_SECONDS,
      },
    });
  } catch (error: any) {
    logger.error("Error registering user:", error);
    
    if (error.code === "23505") {
      // Unique constraint violation
      res.status(400).json({
        status: "error",
        error: "User with this email already exists",
      });
      return;
    }

    failJson(res, 500, "polis_err_register_failed", error);
  }
}

/**
 * POST /api/v3/auth/login
 * Authenticate user with email and password
 */
export async function handle_POST_auth_login(
  req: Request,
  res: Response
) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        status: "error",
        error: "Email and password are required",
      });
      return;
    }

    // Get user by email
    const users = (await pg.queryP(
      "SELECT uid, email, hname, username, is_owner FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    )) as {
      uid: number;
      email: string;
      hname: string | null;
      username: string | null;
      is_owner: boolean;
    }[];

    if (users.length === 0) {
      res.status(401).json({
        status: "error",
        error: "Invalid email or password",
      });
      return;
    }

    const user = users[0];

    // Get password hash
    const passwordHashes = (await pg.queryP(
      "SELECT pwhash FROM jianiuevyew WHERE uid = $1",
      [user.uid]
    )) as { pwhash: string }[];

    if (passwordHashes.length === 0) {
      res.status(401).json({
        status: "error",
        error: "Invalid email or password",
      });
      return;
    }

    // Verify password
    const isValid = await bcrypt.compare(password, passwordHashes[0].pwhash);

    if (!isValid) {
      res.status(401).json({
        status: "error",
        error: "Invalid email or password",
      });
      return;
    }

    // Determine role (admin if is_owner, otherwise participant)
    const role = user.is_owner ? "admin" : "participant";

    // Issue OIDC-compatible token
    const token = issueOidcCompatibleToken(
      user.uid,
      user.email,
      user.hname || undefined,
      role
    );

    res.status(200).json({
      status: "ok",
      user: {
        uid: user.uid,
        email: user.email,
        name: user.hname || user.email,
        role: role,
        email_verified: true, // Assume verified for password users
      },
      auth: {
        token,
        token_type: "Bearer",
        expires_in: JWT_EXPIRATION_SECONDS,
      },
    });
  } catch (error: any) {
    logger.error("Error logging in user:", error);
    failJson(res, 500, "polis_err_login_failed", error);
  }
}

