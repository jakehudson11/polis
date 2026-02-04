/**
 * Permission Middleware
 * Checks user permissions for various actions
 */

import { Response, NextFunction } from "express";
import { RequestWithP } from "../d";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";
import { getPidPromise } from "../user";

/**
 * Middleware to ensure the current user owns the conversation
 */
export function ensureConversationOwner() {
  return async function (req: RequestWithP, res: Response, next: NextFunction) {
    try {
      const { zid, uid } = req.p;

      if (!zid || uid === undefined) {
        return failJson(res, 400, "Missing required parameters");
      }

      const rows = (await pg.queryP(
        "SELECT owner FROM conversations WHERE zid = $1",
        [zid]
      )) as Array<{ owner: number }>;

      if (!rows || rows.length === 0) {
        return failJson(res, 404, "Conversation not found");
      }

      if (rows[0].owner !== uid) {
        return failJson(res, 403, "polis_err_not_conversation_owner");
      }

      next();
    } catch (err) {
      console.error("Error checking conversation ownership:", err);
      failJson(res, 500, "Permission check failed", err);
    }
  };
}

/**
 * Middleware to ensure the current user is a participant in the conversation
 */
export function ensureConversationParticipant() {
  return async function (req: RequestWithP, res: Response, next: NextFunction) {
    try {
      const { zid, uid } = req.p;

      if (!zid || uid === undefined) {
        return failJson(res, 400, "Missing required parameters");
      }

      const pid = await getPidPromise(zid, uid);

      if (pid === -1) {
        return failJson(res, 403, "polis_err_not_conversation_participant");
      }

      // Store pid in request for downstream handlers
      req.p.pid = pid;

      next();
    } catch (err) {
      console.error("Error checking participant status:", err);
      failJson(res, 500, "Permission check failed", err);
    }
  };
}

/**
 * Middleware to ensure the current user is either owner or participant
 */
export function ensureConversationAccess() {
  return async function (req: RequestWithP, res: Response, next: NextFunction) {
    try {
      const { zid, uid } = req.p;

      if (!zid || uid === undefined) {
        return failJson(res, 400, "Missing required parameters");
      }

      // Check if owner
      const ownerRows = (await pg.queryP(
        "SELECT owner FROM conversations WHERE zid = $1",
        [zid]
      )) as Array<{ owner: number }>;

      if (!ownerRows || ownerRows.length === 0) {
        return failJson(res, 404, "Conversation not found");
      }

      const isOwner = ownerRows[0].owner === uid;

      if (isOwner) {
        return next();
      }

      // Check if participant
      const pid = await getPidPromise(zid, uid);

      if (pid === -1) {
        return failJson(res, 403, "polis_err_no_conversation_access");
      }

      // Store pid in request for downstream handlers
      req.p.pid = pid;

      next();
    } catch (err) {
      console.error("Error checking conversation access:", err);
      failJson(res, 500, "Permission check failed", err);
    }
  };
}

