import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import pgQuery from "../db/pg-query";
import logger from "../utils/logger";
import { failJson } from "../utils/fail";

/**
 * Middleware to authenticate requests using API keys
 * Expects Authorization: Bearer <api_key> header
 */
export function apiKeyAuth() {
  return async function apiKeyAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          status: "error",
          message: "Missing or invalid Authorization header",
        });
      }

      const apiKey = authHeader.substring(7); // Remove "Bearer " prefix

      // Hash the provided API key
      const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

      // Look up the API key in the database
      const query = `
        SELECT 
          key_id,
          name,
          can_read_transcripts,
          can_post_comments,
          can_manage_meetings,
          is_active
        FROM api_keys
        WHERE key_hash = $1
      `;

      const result = await pgQuery.queryP(query, [keyHash]) as any[];

      if (result.length === 0) {
        logger.warn("Invalid API key attempted", { keyHash: keyHash.substring(0, 8) + "..." });
        return res.status(401).json({
          status: "error",
          message: "Invalid API key",
        });
      }

      const apiKeyRecord = result[0];

      // Check if key is active
      if (!apiKeyRecord.is_active) {
        logger.warn("Inactive API key attempted", { keyId: apiKeyRecord.key_id });
        return res.status(401).json({
          status: "error",
          message: "API key is inactive",
        });
      }

      // Update last_used_at
      await pgQuery.queryP(
        `UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = $1`,
        [apiKeyRecord.key_id]
      );

      // Attach API key info to request
      req.p = req.p || {};
      req.p.apiKey = {
        key_id: apiKeyRecord.key_id,
        name: apiKeyRecord.name,
        can_read_transcripts: apiKeyRecord.can_read_transcripts,
        can_post_comments: apiKeyRecord.can_post_comments,
        can_manage_meetings: apiKeyRecord.can_manage_meetings,
      };

      next();
    } catch (error) {
      logger.error("Error in API key authentication", error);
      return res.status(500).json({
        status: "error",
        message: "Authentication error",
      });
    }
  };
}

/**
 * Optional API key auth - doesn't fail if no key is provided
 * Useful for endpoints that support both API key and other auth methods
 */
export function apiKeyAuthOptional() {
  return async function apiKeyAuthOptionalMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // No API key provided, continue without it
      return next();
    }

    // Try to authenticate with API key
    return apiKeyAuth()(req, res, next);
  };
}


