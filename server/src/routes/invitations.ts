/**
 * Invitation and Join Request Handlers
 * Handles conversation invitations and join approval workflows
 */

import { Response } from "express";
import { RequestWithP } from "../d";
import { failJson } from "../utils/fail";
import pg from "../db/pg-query";
import logger from "../utils/logger";
import crypto from "crypto";
import { addParticipant } from "../participant";

// finishOne is a global function available in the server context
declare function finishOne(res: any, data: any): void;

/**
 * POST /api/v3/conversations/:conversation_id/invitations
 * Generate a new invitation link for a conversation (admin only)
 */
export async function handle_POST_create_invitation(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid } = req.p;

    // Generate a unique invitation token
    const invitation_token = crypto.randomBytes(32).toString("hex");

    // Create invitation record
    const rows = (await pg.queryP(
      `INSERT INTO conversation_invitations 
       (zid, created_by, invitation_token) 
       VALUES ($1, $2, $3) 
       RETURNING invitation_id, invitation_token`,
      [zid, req.p.uid, invitation_token]
    )) as Array<{ invitation_id: number; invitation_token: string }>;

    const invite = rows[0];

    // Generate the full invite URL
    const invite_url = `${process.env.PUBLIC_SERVICE_URL || "http://localhost:5173"}/invite/${req.p.conversation_id}`;

    finishOne(res, {
      invitation_id: invite.invitation_id,
      invitation_token: invite.invitation_token,
      invite_url,
    });
  } catch (err) {
    logger.error("Error creating invitation:", err);
    failJson(res, 500, "Failed to create invitation", err);
  }
}

/**
 * PATCH /api/v3/conversations/:conversation_id/settings
 * Update conversation settings (admin only)
 */
export async function handle_PATCH_conversation_settings(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid } = req.p;
    const { join_mode } = req.body;

    if (join_mode && !['open', 'approval'].includes(join_mode)) {
      return failJson(res, 400, "Invalid join_mode. Must be 'open' or 'approval'");
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (join_mode) {
      updates.push(`join_mode = $${paramIndex++}`);
      values.push(join_mode);
    }

    if (updates.length === 0) {
      return failJson(res, 400, "No valid settings provided");
    }

    values.push(zid);
    await pg.queryP(
      `UPDATE conversations SET ${updates.join(', ')} WHERE zid = $${paramIndex}`,
      values
    );

    finishOne(res, { status: "ok", join_mode });
  } catch (err) {
    logger.error("Error updating conversation settings:", err);
    failJson(res, 500, "Failed to update conversation settings", err);
  }
}

/**
 * POST /api/v3/conversations/:conversation_id/join
 * Join a conversation (creates participant or join request based on join_mode)
 */
export async function handle_POST_join_conversation(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid, uid } = req.p;

    // Get conversation join_mode
    const convRows = (await pg.queryP(
      "SELECT join_mode, owner FROM conversations WHERE zid = $1",
      [zid]
    )) as Array<{ join_mode: string; owner: number }>;

    if (!convRows || convRows.length === 0) {
      return failJson(res, 404, "Conversation not found");
    }

    const conversation = convRows[0];

    // Check if user is already a participant
    const existingPart = (await pg.queryP(
      "SELECT pid FROM participants WHERE zid = $1 AND uid = $2",
      [zid, uid]
    )) as Array<{ pid: number }>;

    if (existingPart && existingPart.length > 0) {
      return finishOne(res, {
        status: "participant",
        message: "Already a participant",
        pid: existingPart[0].pid,
      });
    }

    // Check if user already has a pending request
    const existingReq = (await pg.queryP(
      "SELECT status FROM conversation_join_requests WHERE zid = $1 AND uid = $2",
      [zid, uid]
    )) as Array<{ status: string }>;

    if (existingReq && existingReq.length > 0) {
      const requestStatus = existingReq[0].status;
      if (requestStatus === 'pending') {
        return finishOne(res, {
          status: "pending",
          message: "Join request pending admin approval",
        });
      } else if (requestStatus === 'rejected') {
        return failJson(res, 403, "Join request was rejected");
      }
    }

    // If join_mode is 'open' OR user is the owner, create participant immediately
    if (conversation.join_mode === 'open' || conversation.owner === uid) {
      const rows = await addParticipant(zid, uid);
      const pid = rows[0].pid;

      return finishOne(res, {
        status: "participant",
        message: "Successfully joined conversation",
        pid,
      });
    }

    // If join_mode is 'approval', create a join request
    if (conversation.join_mode === 'approval') {
      await pg.queryP(
        `INSERT INTO conversation_join_requests (zid, uid) 
         VALUES ($1, $2) 
         ON CONFLICT (zid, uid) DO UPDATE 
         SET status = 'pending', requested_at = now_as_millis()`,
        [zid, uid]
      );

      return finishOne(res, {
        status: "pending",
        message: "Join request submitted and pending admin approval",
      });
    }

    failJson(res, 500, "Unknown join mode");
  } catch (err) {
    logger.error("Error joining conversation:", err);
    failJson(res, 500, "Failed to join conversation", err);
  }
}

/**
 * GET /api/v3/conversations/:conversation_id/join-requests
 * Get pending join requests for a conversation (admin only)
 */
export async function handle_GET_join_requests(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid } = req.p;

    const rows = await pg.queryP(
      `SELECT jr.request_id, jr.uid, jr.status, jr.requested_at, jr.reviewed_at, jr.reviewed_by,
              u.email, u.hname as user_name
       FROM conversation_join_requests jr
       JOIN users u ON jr.uid = u.uid
       WHERE jr.zid = $1
       ORDER BY 
         CASE jr.status 
           WHEN 'pending' THEN 1 
           WHEN 'approved' THEN 2 
           WHEN 'rejected' THEN 3 
         END,
         jr.requested_at DESC`,
      [zid]
    );

    finishOne(res, { requests: rows });
  } catch (err) {
    logger.error("Error fetching join requests:", err);
    failJson(res, 500, "Failed to fetch join requests", err);
  }
}

/**
 * POST /api/v3/conversations/:conversation_id/join-requests/:request_id/review
 * Approve or reject a join request (admin only)
 */
export async function handle_POST_review_join_request(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid, uid: reviewerUid } = req.p;
    const request_id = parseInt(req.params.request_id);
    const { action } = req.body;

    if (!['approved', 'rejected'].includes(action)) {
      return failJson(res, 400, "Action must be 'approved' or 'rejected'");
    }

    // Get the join request
    const requestRows = (await pg.queryP(
      "SELECT uid, status FROM conversation_join_requests WHERE request_id = $1 AND zid = $2",
      [request_id, zid]
    )) as Array<{ uid: number; status: string }>;

    if (!requestRows || requestRows.length === 0) {
      return failJson(res, 404, "Join request not found");
    }

    const joinRequest = requestRows[0];

    if (joinRequest.status !== 'pending') {
      return failJson(res, 400, "Join request has already been reviewed");
    }

    // Update the join request status
    await pg.queryP(
      `UPDATE conversation_join_requests 
       SET status = $1, reviewed_at = now_as_millis(), reviewed_by = $2 
       WHERE request_id = $3`,
      [action, reviewerUid, request_id]
    );

    // If approved, create a participant
    if (action === 'approved') {
      const rows = await addParticipant(zid, joinRequest.uid);
      const pid = rows[0].pid;

      return finishOne(res, {
        status: "ok",
        action,
        message: "Join request approved and participant created",
        pid,
      });
    }

    // If rejected
    finishOne(res, {
      status: "ok",
      action,
      message: "Join request rejected",
    });
  } catch (err) {
    logger.error("Error reviewing join request:", err);
    failJson(res, 500, "Failed to review join request", err);
  }
}

/**
 * GET /api/v3/users/me/conversations
 * Get all conversations the current user has access to (as owner or participant)
 */
export async function handle_GET_user_conversations(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { uid } = req.p;

    const rows = await pg.queryP(
      `SELECT DISTINCT c.*, z.zinvite as conversation_id,
              CASE 
                WHEN c.owner = $1 THEN 'owner'
                WHEN p.pid IS NOT NULL THEN 'participant'
                WHEN jr.status = 'pending' THEN 'pending'
                ELSE 'none'
              END as my_status,
              p.pid
       FROM conversations c
       LEFT JOIN zinvites z ON c.zid = z.zid
       LEFT JOIN participants p ON c.zid = p.zid AND p.uid = $1
       LEFT JOIN conversation_join_requests jr ON c.zid = jr.zid AND jr.uid = $1
       WHERE c.owner = $1 OR p.uid = $1 OR jr.uid = $1
       ORDER BY c.modified DESC`,
      [uid]
    );

    finishOne(res, { conversations: rows });
  } catch (err) {
    logger.error("Error fetching user conversations:", err);
    failJson(res, 500, "Failed to fetch conversations", err);
  }
}

/**
 * GET /api/v3/conversations/:conversation_id/my-status
 * Get the current user's status for a specific conversation
 */
export async function handle_GET_my_conversation_status(
  req: RequestWithP,
  res: Response
): Promise<void> {
  try {
    const { zid, uid } = req.p;

    // Get conversation owner
    const convRows = (await pg.queryP(
      "SELECT owner FROM conversations WHERE zid = $1",
      [zid]
    )) as Array<{ owner: number }>;

    if (!convRows || convRows.length === 0) {
      return failJson(res, 404, "Conversation not found");
    }

    const isOwner = convRows[0].owner === uid;

    // Check if participant
    const partRows = (await pg.queryP(
      "SELECT pid FROM participants WHERE zid = $1 AND uid = $2",
      [zid, uid]
    )) as Array<{ pid: number }>;

    const isParticipant = partRows && partRows.length > 0;

    // Check for pending join request
    const reqRows = (await pg.queryP(
      "SELECT status FROM conversation_join_requests WHERE zid = $1 AND uid = $2",
      [zid, uid]
    )) as Array<{ status: string }>;

    const hasPendingRequest = reqRows && reqRows.length > 0 && reqRows[0].status === 'pending';

    let status = 'none';
    if (isOwner) status = 'owner';
    else if (isParticipant) status = 'participant';
    else if (hasPendingRequest) status = 'pending';

    finishOne(res, {
      status,
      is_owner: isOwner,
      is_participant: isParticipant,
      has_pending_request: hasPendingRequest,
      pid: isParticipant ? partRows[0].pid : null,
    });
  } catch (err) {
    logger.error("Error fetching conversation status:", err);
    failJson(res, 500, "Failed to fetch conversation status", err);
  }
}

