import { NextFunction, Request, Response } from "express";
import Config from "../config";
import jwt from "jsonwebtoken";
import logger from "../utils/logger";
import {
  isAnonymousJWT,
  anonymousJwtValidation,
  anonymousJwtValidationOptional,
  extractUserFromAnonymousJWT,
} from "./anonymous-jwt";
import {
  jwtValidation,
  jwtValidationOptional,
  extractUserFromJWT,
} from "./jwt-middleware";
import { getPublicKey } from "./jwt-utils";
import { getUserByEmail } from "./email-password";
import {
  isStandardUserJWT,
  standardUserJwtValidation,
  standardUserJwtValidationOptional,
  extractUserFromStandardUserJWT,
} from "./standard-user-jwt";
import {
  isXidJWT,
  xidJwtValidation,
  xidJwtValidationOptional,
  extractUserFromXidJWT,
} from "./xid-jwt";

// Check if a token is an email/password JWT (signed by us)
function _isEmailPasswordJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      return false;
    }

    const payload = decoded.payload;

    // Prefer explicit claim
    const emailPasswordClaim =
      payload[`${Config.authNamespace}email_password_user`];
    if (emailPasswordClaim) return true;

    // Fallback: email-password tokens use sub prefix "email|"
    if (typeof payload.sub === "string" && payload.sub.startsWith("email|")) {
      return true;
    }

    return false;
  } catch (error) {
    logger.warn("Error checking if token is email/password JWT:", error);
    return false;
  }
}

// Check if a token is an OIDC JWT (signed by the IdP)
function _isOidcJWT(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true }) as any;

    if (!decoded || !decoded.payload) {
      logger.warn("_isOidcJWT: Token decode failed", {
        hasDecoded: !!decoded,
        hasPayload: !!decoded?.payload,
      });
      return false;
    }

    const payload = decoded.payload;

    // Handle audience as either string or array (JWT spec allows both)
    let audMatch = false;
    if (typeof payload.aud === "string") {
      audMatch = payload.aud === Config.authAudience;
    } else if (Array.isArray(payload.aud)) {
      audMatch = payload.aud.includes(Config.authAudience);
    }

    // Standard user JWTs have specific claims
    const issMatch = payload.iss === Config.authIssuer;
    const isOidc = !!(audMatch && issMatch);

    // Exclude email/password tokens from OIDC check
    const emailPasswordClaim =
      payload[`${Config.authNamespace}email_password_user`];
    const subIsEmail =
      typeof payload.sub === "string" && payload.sub.startsWith("email|");
    return isOidc && !emailPasswordClaim && !subIsEmail;
  } catch (error) {
    logger.warn("Error checking if token is OIDC JWT:", error);
    return false;
  }
}

// Validate email/password JWT with our public key
async function _validateEmailPasswordJWT(
  token: string,
  isOptional: boolean
): Promise<any> {
  try {
    const publicKey = getPublicKey();
    const decoded = jwt.verify(token, publicKey, {
      audience: Config.authAudience as string,
      issuer: Config.authIssuer as string,
      algorithms: ["RS256"],
    }) as any;

    return decoded;
  } catch (error: any) {
    if (isOptional) {
      return null;
    }
    throw error;
  }
}

// Extract user info from email/password JWT
async function _extractUserFromEmailPasswordJWT(
  req: any,
  payload: any,
  assigner?: (req: any, key: string, value: any) => void
): Promise<void> {
  const email = payload.email;
  if (!email) {
    throw new Error("Email/password token missing email claim");
  }

  const user = await getUserByEmail(email);
  if (!user) {
    throw new Error("User not found for email/password token");
  }

  req.p = req.p || {};
  req.p.uid = user.uid;
  req.p.email = user.email;
  req.p.name = user.hname || user.username;
  req.p.emailVerified = payload.email_verified || false;
  req.p.emailPasswordUser = true;
  // Explicitly do NOT set pid - it should be created by ensureParticipant
  // req.p.pid should remain undefined

  console.log("🔍 [_extractUserFromEmailPasswordJWT] Extracted user:", {
    uid: user.uid,
    email: user.email,
    pid: req.p.pid, // Should be undefined
  });

  if (assigner) {
    assigner(req, "uid", user.uid);
  }
}

/**
 * Hybrid JWT validation middleware that supports OIDC, XID, Anonymous, and Standard User JWTs
 * This allows the same endpoints to work with all authentication methods
 */
function _createHybridJwtMiddleware(
  assigner?: (req: any, key: string, value: any) => void,
  isOptional = false
) {
  return async function hybridJwtMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const internalSecret = process.env.POLIS_INTERNAL_PROXY_SECRET;
    const internalKey = req.headers["x-polis-internal-key"];
    const internalUidHeader = req.headers["x-polis-uid"];

    if (
      internalSecret &&
      internalKey === internalSecret &&
      internalUidHeader
    ) {
      const uidValue = Array.isArray(internalUidHeader)
        ? internalUidHeader[0]
        : internalUidHeader;
      const uid = Number.parseInt(uidValue, 10);

      if (!Number.isNaN(uid)) {
        const internalEmailHeader = req.headers["x-polis-email"];
        const internalNameHeader = req.headers["x-polis-name"];
        const email = Array.isArray(internalEmailHeader)
          ? internalEmailHeader[0]
          : internalEmailHeader;
        const name = Array.isArray(internalNameHeader)
          ? internalNameHeader[0]
          : internalNameHeader;

        req.p = req.p || {};
        req.p.uid = uid;
        if (email) {
          req.p.email = email;
        }
        if (name) {
          req.p.name = name;
        }
        req.p.emailVerified = true;

        req.p.delphiEnabled = true; // Internal proxy has full access including Delphi

        return next();
      }
    }

    const authHeader = req.headers.authorization;

    // If we have no Bearer token, and auth is optional, just continue.
    // If auth is required, send a 401. Let's handle this first.
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (isOptional) {
        logger.debug("No JWT token found, continuing without authentication");
        return next();
      } else {
        logger.debug("No JWT token found, authentication required");
        return res.status(401).json({
          error: "No authentication token found",
        });
      }
    }

    // We have a Bearer token, so let's validate it.
    const token = authHeader.substring(7);

    try {
      // Determine which validation to use based on token type
      if (isXidJWT(token)) {
        logger.debug("Detected XID JWT, using XID validation");

        // Use XID JWT validation
        const xidValidator = isOptional
          ? xidJwtValidationOptional
          : xidJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          xidValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromXidJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("XID JWT validation successful");
        return next();
      } else if (isAnonymousJWT(token)) {
        logger.debug("Detected Anonymous JWT, using anonymous validation");

        // Use Anonymous JWT validation
        const anonValidator = isOptional
          ? anonymousJwtValidationOptional
          : anonymousJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          anonValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromAnonymousJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("Anonymous JWT validation successful");
        return next();
      } else if (isStandardUserJWT(token)) {
        logger.debug(
          "Detected Standard User JWT, using standard user validation"
        );

        // Use Standard User JWT validation
        const standardUserValidator = isOptional
          ? standardUserJwtValidationOptional
          : standardUserJwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          standardUserValidator(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromStandardUserJWT(assigner)(req, res, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        logger.debug("Standard User JWT validation successful");
        return next();
      } else if (_isEmailPasswordJWT(token)) {
        logger.debug(
          "Detected Email/Password JWT, using email/password validation"
        );

        const payload = await _validateEmailPasswordJWT(token, isOptional);
        if (!payload) {
          return next();
        }

        await _extractUserFromEmailPasswordJWT(req, payload, assigner);
        logger.debug("Email/Password JWT validation successful");
        return next();
      } else if (_isOidcJWT(token)) {
        logger.debug("Detected OIDC JWT, using OIDC validation");

        // Use OIDC JWT validation
        const oidcValidator = isOptional
          ? jwtValidationOptional
          : jwtValidation;

        // First validate the token
        await new Promise<void>((resolve, reject) => {
          oidcValidator(req, res, (err?: any) => {
            if (err) {
              logger.error("OIDC JWT validation failed", {
                error: err.message,
                code: err.code,
                name: err.name,
                inner: err.inner,
              });
              reject(err);
            } else {
              resolve();
            }
          });
        });

        // Then extract user info
        await new Promise<void>((resolve, reject) => {
          extractUserFromJWT(assigner)(req, res, (err?: any) => {
            if (err) {
              logger.error("OIDC JWT user extraction failed", {
                error: err.message,
              });
              reject(err);
            } else {
              resolve();
            }
          });
        });

        logger.debug("OIDC JWT validation successful");
        return next();
      } else {
        logger.warn("Token does not match any known JWT type", {
          tokenSample: token.substring(0, 50) + "...",
        });

        return res.status(401).json({
          error: "Invalid token format",
          details: "Token does not match any supported JWT type",
        });
      }
    } catch (error) {
      logger.error("JWT validation failed", {
        message: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      });

      // If a token was provided but is invalid, always return 401
      // "Optional" auth only applies to missing tokens, not invalid ones
      return res.status(401).json({
        error: "Invalid authentication token",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
}

/**
 * Required hybrid JWT authentication
 */
const hybridAuth = (assigner?: (req: any, key: string, value: any) => void) =>
  _createHybridJwtMiddleware(assigner, false);

/**
 * Optional hybrid JWT authentication
 */
const hybridAuthOptional = (
  assigner?: (req: any, key: string, value: any) => void
) => _createHybridJwtMiddleware(assigner, true);

export { hybridAuth, hybridAuthOptional };
