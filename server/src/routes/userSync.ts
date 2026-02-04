/**
 * User Synchronization API
 * 
 * This endpoint allows external systems (like Agora) to sync users into Polis.
 * It creates or updates users based on external identity information.
 */

import { Request, Response } from "express";
import { failJson } from "../utils/fail";
import logger from "../utils/logger";
import pg from "../db/pg-query";

interface UserSyncRequest extends Request {
  body: {
    email: string;
    name?: string;
    external_id: string;  // Unique identifier from external system
    external_system?: string;  // Name of external system (default: "agora")
  };
}

interface UserSyncResponse {
  uid: number;
  email: string;
  created: boolean;
  external_id: string;
}

/**
 * POST /api/v3/users/sync
 * 
 * Sync a user from an external system into Polis.
 * Creates a new user if they don't exist, or returns existing user if they do.
 * 
 * Request Body:
 * {
 *   "email": "user@example.com",
 *   "name": "User Name",
 *   "external_id": "agora-user-123",
 *   "external_system": "agora"
 * }
 * 
 * Response:
 * {
 *   "uid": 42,
 *   "email": "user@example.com",
 *   "created": true,
 *   "external_id": "agora-user-123"
 * }
 */
export async function handle_POST_users_sync(
  req: UserSyncRequest,
  res: Response
): Promise<void> {
  const { email, name, external_id, external_system = "agora" } = req.body;

  // Validation
  if (!email || typeof email !== "string") {
    failJson(res, 400, "polis_err_user_sync_missing_email");
    return;
  }

  if (!external_id || typeof external_id !== "string") {
    failJson(res, 400, "polis_err_user_sync_missing_external_id");
    return;
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    failJson(res, 400, "polis_err_user_sync_invalid_email");
    return;
  }

  try {
    logger.info("User sync request", {
      email,
      external_id,
      external_system,
      has_name: !!name,
    });

    // Check if user already exists by external_id
    let existingUserByXid: any = null;
    try {
      const xidRows = (await pg.queryP(
        `SELECT uid, x_profile_image_url FROM xids 
         WHERE xid = $1 AND uid IS NOT NULL 
         ORDER BY created DESC LIMIT 1`,
        [external_id]
      )) as any[];
      
      if (xidRows && xidRows.length > 0) {
        existingUserByXid = xidRows[0];
      }
    } catch (error) {
      logger.warn("Error checking xid", { error, external_id });
    }

    // Check if user already exists by email
    let existingUserByEmail: any = null;
    try {
      const emailRows = (await pg.queryP(
        `SELECT uid, hname FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      )) as any[];
      
      if (emailRows && emailRows.length > 0) {
        existingUserByEmail = emailRows[0];
      }
    } catch (error) {
      logger.warn("Error checking email", { error, email });
    }

    let uid: number;
    let created = false;

    // Determine which user to use or create new
    if (existingUserByXid) {
      // User exists with this external_id
      uid = existingUserByXid.uid;
      logger.info("Found existing user by external_id", { uid, external_id });

      // Update user info if provided
      if (name) {
        try {
          await pg.queryP(
            `UPDATE users SET hname = $1 WHERE uid = $2`,
            [name, uid]
          );
        } catch (error) {
          logger.warn("Error updating user name", { error, uid });
        }
      }
    } else if (existingUserByEmail) {
      // User exists with this email but different external_id
      uid = existingUserByEmail.uid;
      logger.info("Found existing user by email", { uid, email });

      // Create xid mapping
      try {
        await pg.queryP(
          `INSERT INTO xids (uid, owner, xid, x_profile_image_url) 
           VALUES ($1, $2, $3, $4) 
           ON CONFLICT (owner, xid) DO UPDATE SET uid = $1`,
          [uid, uid, external_id, null]
        );
      } catch (error) {
        logger.warn("Error creating xid mapping", { error, uid, external_id });
      }

      // Update name if provided and current name is empty
      if (name && !existingUserByEmail.hname) {
        try {
          await pg.queryP(
            `UPDATE users SET hname = $1 WHERE uid = $2`,
            [name, uid]
          );
        } catch (error) {
          logger.warn("Error updating user name", { error, uid });
        }
      }
    } else {
      // Create new user
      created = true;
      
      try {
        const userRows = (await pg.queryP(
          `INSERT INTO users (hname, username, email, created) 
           VALUES ($1, $2, $3, default) 
           RETURNING uid`,
          [name || email.split("@")[0], null, email]
        )) as any[];

        uid = userRows[0].uid;
        logger.info("Created new user", { uid, email, external_id });

        // Create xid mapping
        await pg.queryP(
          `INSERT INTO xids (uid, owner, xid, x_profile_image_url) 
           VALUES ($1, $2, $3, $4)`,
          [uid, uid, external_id, null]
        );
      } catch (error: any) {
        if (error.message && error.message.includes("duplicate key")) {
          // Race condition: user was created between our checks
          // Try to fetch the user again
          const retryRows = (await pg.queryP(
            `SELECT uid FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
            [email]
          )) as any[];
          
          if (retryRows && retryRows.length > 0) {
            uid = retryRows[0].uid;
            created = false;
            logger.info("User created by another request (race condition)", { uid, email });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    // Return response
    const response: UserSyncResponse = {
      uid,
      email,
      created,
      external_id,
    };

    logger.info("User sync successful", response);
    res.status(created ? 201 : 200).json(response);

  } catch (error: any) {
    logger.error("User sync failed", {
      email,
      external_id,
      error: error.message,
      stack: error.stack,
    });

    failJson(res, 500, "polis_err_user_sync_failed", error);
  }
}

