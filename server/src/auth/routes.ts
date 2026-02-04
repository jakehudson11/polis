import { createAnonUser } from "./create-user";
import { createXidRecord, xidExists } from "../xids";
import { deleteSuzinvite } from "./auth";
import { failJson } from "../utils/fail";
import { getConversationInfo } from "../conversation";
import { getSUZinviteInfo } from "../invites/suzinvites";
import { getUserInfoForUid2 } from "../user";
import { issueAnonymousJWT } from "./anonymous-jwt";
import { isXidAllowed } from "../xids";
import { joinConversation } from "../participant";
import { userHasAnsweredZeQuestions } from "../server-helpers";
import logger from "../utils/logger";
import type { ParticipantInfo } from "../d";
import {
  createUserWithPassword,
  getUserByEmail,
  getPasswordHash,
  verifyPassword,
  issueEmailPasswordJWT,
  updatePassword,
} from "./email-password";
import { generateTokenP } from "./generate-token";
import { sendTextEmail } from "../email/senders";
import Config from "../config";
import pg from "../db/pg-query";

interface DeregisterRequest {
  p?: { showPage?: any };
}

interface DeregisterResponse {
  status: (code: number) => {
    json: (data: any) => void;
  };
}

interface JoinRequest {
  p: {
    answers: any;
    uid?: number;
    suzinvite: string;
    zid: number;
    referrer: string;
    parent_url: string;
  };
}

interface JoinResponse {
  status: (code: number) => {
    json: (data: {
      pid: number;
      uid?: number;
      token?: string;
      isAnonymous?: boolean;
    }) => void;
  };
}

interface JoinParams {
  answers: any;
  existingAuth: boolean;
  suzinvite: string;
  uid?: number;
  zid: number;
  referrer: string;
  parent_url: string;
  conv?: any;
  user?: any;
  xid?: string;
  [key: string]: any;
}

/**
 * JWT-based logout handler
 * With JWTs, logout is primarily a client-side operation.
 * The server doesn't need to track sessions or clear cookies.
 */
function handle_POST_auth_deregister_jwt(
  req: DeregisterRequest,
  res: DeregisterResponse
): void {
  // With JWT auth, the server doesn't need to do anything
  // The client is responsible for:
  // 1. Removing the JWT from localStorage/memory
  // 2. Optionally calling OIDC logout endpoint

  res.status(200).json({
    status: "success",
    message: "Logout successful. Please remove your JWT token.",
  });
}

async function handle_POST_joinWithInvite(
  req: JoinRequest,
  res: JoinResponse
): Promise<void> {
  try {
    const result = await _joinWithZidOrSuzinvite({
      answers: req.p.answers,
      existingAuth: !!req.p.uid,
      suzinvite: req.p.suzinvite,
      uid: req.p.uid,
      zid: req.p.zid,
      referrer: req.p.referrer,
      parent_url: req.p.parent_url,
    });

    const response: any = {
      pid: result.pid,
      uid: result.uid,
    };

    // If anonymous user, issue Anonymous JWT
    if (!req.p.uid && result.uid) {
      const anonymousToken = issueAnonymousJWT(
        result.conversation_id || String(result.zid),
        result.uid,
        result.pid
      );
      response.token = anonymousToken;
      response.isAnonymous = true;
    }

    res.status(200).json(response);
  } catch (err: any) {
    if (err?.message?.match(/polis_err_need_full_user/)) {
      failJson(res, 403, err.message, err);
    } else if (err?.message?.match(/polis_err_xid_required/)) {
      failJson(res, 403, err.message, err);
    } else if (err?.message?.match(/polis_err_xid_not_allowed/)) {
      failJson(res, 403, err.message, err);
    } else if (err?.message) {
      failJson(res, 500, err.message, err);
    } else {
      failJson(res, 500, "polis_err_joinWithZidOrSuzinvite", err);
    }
  }
}

async function _joinWithZidOrSuzinvite(params: JoinParams): Promise<any> {
  let o = { ...params };

  // Get suzinvite info or use zid
  if (o.suzinvite) {
    const suzinviteInfo = await getSUZinviteInfo(o.suzinvite);
    o = Object.assign(o, suzinviteInfo);
  } else if (!o.zid) {
    throw new Error("polis_err_missing_invite");
  }

  // Get conversation info
  const conv = await getConversationInfo(o.zid);
  o.conv = conv;

  // Get user info if uid exists
  if (o.uid) {
    const user = await getUserInfoForUid2(o.uid);
    o.user = user;
  } else {
    // Create anonymous user
    const uid = await createAnonUser();
    o.uid = uid;
  }

  // Check if user has answered required questions
  await userHasAnsweredZeQuestions(o.zid, o.answers);

  // Join conversation
  const info: ParticipantInfo = {};
  if (o.referrer) {
    info.referrer = o.referrer;
  }
  if (o.parent_url) {
    info.parent_url = o.parent_url;
  }

  const ptpt = await joinConversation(o.zid, o.uid, info, o.answers);
  o = Object.assign(o, ptpt);

  // XID validation logic
  if (o.conv.use_xid_whitelist) {
    if (o.xid) {
      const isAllowed = await isXidAllowed(o.xid, o.zid, o.conv.owner);
      if (!isAllowed) {
        throw new Error("polis_err_xid_not_allowed");
      }
    } else {
      throw new Error("polis_err_xid_required");
    }
  } else if (o.conv.xid_required) {
    if (!o.xid) {
      throw new Error("polis_err_xid_required");
    }
  }

  // Handle XID if present
  if (o.xid) {
    const exists = await xidExists(o.xid, o.conv.org_id, o.uid);
    if (!exists) {
      await createXidRecord(o.xid, o.conv.owner, o.uid, o.zid);
    }
  }

  // Delete suzinvite if it was used
  if (o.suzinvite) {
    await deleteSuzinvite(o.suzinvite);
  }

  return o;
}

/**
 * Register a new user with email and password
 */
async function handle_POST_auth_register(
  req: { body: { email: string; password: string; name?: string } },
  res: any
): Promise<void> {
  try {
    const { email, password, name } = req.body;

    // Validation
    if (!email || !password) {
      return failJson(res, 400, "Email and password are required");
    }

    if (password.length < 8) {
      return failJson(res, 400, "Password must be at least 8 characters long");
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return failJson(res, 400, "Invalid email format");
    }

    // Check if user already exists
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return failJson(res, 409, "Email already registered");
    }

    // Create user with password
    const uid = await createUserWithPassword(email, password, name);

    // Get created user info
    const user = await getUserByEmail(email);
    if (!user) {
      return failJson(res, 500, "Failed to retrieve created user");
    }

    // Issue JWT token
    const token = issueEmailPasswordJWT(uid, email, name);

    res.status(200).json({
      status: "ok",
      user: {
        uid: user.uid,
        email: user.email,
        name: user.hname || user.username,
        role: user.is_owner ? "admin" : "participant",
        email_verified: false,
      },
      auth: {
        token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year
      },
    });
  } catch (err: any) {
    logger.error("Registration error:", err);
    if (err.message === "Email already registered") {
      return failJson(res, 409, err.message);
    }
    return failJson(res, 500, "Registration failed", err);
  }
}

/**
 * Login with email and password
 */
async function handle_POST_auth_login(
  req: { body: { email: string; password: string } },
  res: any
): Promise<void> {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return failJson(res, 400, "Email and password are required");
    }

    // Get user by email
    const user = await getUserByEmail(email);
    if (!user) {
      return failJson(res, 401, "Invalid email or password");
    }

    // Get password hash
    const passwordHash = await getPasswordHash(user.uid);
    if (!passwordHash) {
      return failJson(res, 401, "Invalid email or password");
    }

    // Verify password
    const isValid = await verifyPassword(password, passwordHash);
    if (!isValid) {
      return failJson(res, 401, "Invalid email or password");
    }

    // Issue JWT token
    const token = issueEmailPasswordJWT(user.uid, user.email, user.hname);

    res.status(200).json({
      status: "ok",
      user: {
        uid: user.uid,
        email: user.email,
        name: user.hname || user.username,
        role: user.is_owner ? "admin" : "participant",
        email_verified: false,
      },
      auth: {
        token,
        token_type: "Bearer",
        expires_in: 365 * 24 * 60 * 60, // 1 year
      },
    });
  } catch (err: any) {
    logger.error("Login error:", err);
    return failJson(res, 500, "Login failed", err);
  }
}

/**
 * Request password reset - sends email with reset link
 */
async function handle_POST_auth_forgot_password(
  req: { body: { email: string } },
  res: any
): Promise<void> {
  try {
    const { email } = req.body;

    // Validation
    if (!email) {
      return failJson(res, 400, "Email is required");
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return failJson(res, 400, "Invalid email format");
    }

    // Get user by email
    const user = await getUserByEmail(email);
    
    // Don't reveal if user exists or not (security best practice)
    // Always return success, but only send email if user exists
    if (user) {
      // Delete any existing reset tokens for this user first
      await pg.queryP(
        "DELETE FROM pwreset_tokens WHERE uid = $1;",
        [user.uid]
      );
      
      // Generate reset token
      const resetToken = await generateTokenP(32, false);
      
      // Store token in database (expires after 1 hour)
      await pg.queryP(
        "INSERT INTO pwreset_tokens (uid, token, created) VALUES ($1, $2, now_as_millis());",
        [user.uid, resetToken]
      );

      // Get server URL for reset link
      const serverUrl = Config.getServerUrl();
      const resetLink = `${serverUrl}/reset-password?token=${resetToken}`;

      // Send email
      if (Config.polisFromAddress) {
        try {
          await sendTextEmail(
            Config.polisFromAddress,
            email,
            "Reset your Polis password",
            `You requested to reset your password. Click the link below to reset it:\n\n${resetLink}\n\nThis link will expire in 1 hour. If you didn't request this, please ignore this email.`
          );
        } catch (emailError) {
          logger.error("Failed to send password reset email:", emailError);
          // Still return success to user (don't reveal email failure)
        }
      } else {
        logger.warn("POLIS_FROM_ADDRESS not configured, cannot send password reset email");
      }
    }

    // Always return success (don't reveal if user exists)
    res.status(200).json({
      status: "ok",
      message: "If an account with that email exists, a password reset link has been sent.",
    });
  } catch (err: any) {
    logger.error("Forgot password error:", err);
    return failJson(res, 500, "Failed to process password reset request", err);
  }
}

/**
 * Reset password using token from email
 */
async function handle_POST_auth_reset_password(
  req: { body: { token: string; password: string } },
  res: any
): Promise<void> {
  try {
    const { token, password } = req.body;

    // Validation
    if (!token || !password) {
      return failJson(res, 400, "Token and password are required");
    }

    if (password.length < 8) {
      return failJson(res, 400, "Password must be at least 8 characters long");
    }

    // Find token in database
    const tokenRows = (await pg.queryP_readOnly<{
      uid: number;
      created: number;
    }>(
      "SELECT uid, created FROM pwreset_tokens WHERE token = $1 LIMIT 1;",
      [token]
    )) as { uid: number; created: number }[];

    if (!tokenRows || tokenRows.length === 0) {
      return failJson(res, 400, "Invalid or expired reset token");
    }

    const tokenData = tokenRows[0];
    const tokenAge = Date.now() - tokenData.created;
    const oneHour = 60 * 60 * 1000;

    // Check if token is expired (older than 1 hour)
    if (tokenAge > oneHour) {
      // Delete expired token
      await pg.queryP("DELETE FROM pwreset_tokens WHERE token = $1;", [token]);
      return failJson(res, 400, "Reset token has expired. Please request a new one.");
    }

    // Update password
    await updatePassword(tokenData.uid, password);

    // Delete used token
    await pg.queryP("DELETE FROM pwreset_tokens WHERE token = $1;", [token]);

    res.status(200).json({
      status: "ok",
      message: "Password has been reset successfully.",
    });
  } catch (err: any) {
    logger.error("Reset password error:", err);
    return failJson(res, 500, "Failed to reset password", err);
  }
}

export {
  handle_POST_auth_deregister_jwt,
  handle_POST_joinWithInvite,
  handle_POST_auth_register,
  handle_POST_auth_login,
  handle_POST_auth_forgot_password,
  handle_POST_auth_reset_password,
};
