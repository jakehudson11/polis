import { Request, Response } from "express";
import { failJson } from "../utils/fail";
import { isModerator, isOwner, polisTypes } from "../utils/common";
import { getConversationInfo } from "../conversation";
import {
  buildAndUpdateContext,
} from "../utils/contextBuilder";
import { generateSeedComments } from "../utils/seedCommentGenerator";
import logger from "../utils/logger";
import pg from "../db/pg-query";
import { addParticipant } from "../participant";
import { getPidPromise } from "../user";
import { detectLanguage, getComment } from "../comment";
import { updateConversationModifiedTime, updateLastInteractionTimeForConversation, safeTimestampToMillis } from "../server-helpers";
import _ from "underscore";

interface GenerateSeedCommentsRequest extends Request {
  p: {
    zid: number;
    uid?: number;
    conversation_id: string;
  };
}

/**
 * POST /api/v3/conversations/:conversation_id/generate-seed-comments
 *
 * Generates seed comments from questionnaire context using OpenAI and posts them to the conversation.
 */
export async function handle_POST_generate_seed_comments(
  req: GenerateSeedCommentsRequest,
  res: Response
): Promise<void> {
  logger.info("🎯 generate-seed-comments endpoint called", { 
    params: req.params, 
    p: req.p, 
    body: req.body 
  });
  
  const { zid, uid, conversation_id } = req.p;

  if (!zid) {
    logger.error("Missing zid in req.p", { p: req.p, params: req.params });
    failJson(res, 400, "polis_err_missing_zid");
    return;
  }

  try {
    // 1. Verify caller is conversation owner
    const isConvoOwner = await isOwner(zid, uid!);
    if (!isConvoOwner) {
      failJson(res, 403, "polis_err_generate_seed_comments_auth");
      return;
    }

    // 2. Fetch conversation info
    const conversation = await getConversationInfo(zid);
    if (!conversation) {
      failJson(res, 404, "polis_err_conversation_not_found");
      return;
    }

    const topic = conversation.topic || "Untitled Conversation";
    const description = conversation.description || "";

    // 3. Build context from questionnaire
    logger.info("Building context from questionnaire", { zid });
    const context = await buildAndUpdateContext(zid);

    if (!context || context.trim().length === 0) {
      failJson(
        res,
        400,
        "polis_err_no_questionnaire",
        new Error(
          "No questionnaire found for this conversation. Please set up questionnaire questions and answers first."
        )
      );
      return;
    }

    // 4. Generate seed comments using OpenAI
    logger.info("Generating seed comments via OpenAI", {
      zid,
      topic,
      contextLength: context.length,
    });

    const seedComments = await generateSeedComments(topic, description, context);

    if (!seedComments || seedComments.length === 0) {
      failJson(
        res,
        500,
        "polis_err_no_comments_generated",
        new Error("OpenAI did not generate any comments")
      );
      return;
    }

    // 5. Post seed comments directly (inline bulk comment logic)
    logger.info("Posting generated seed comments", {
      zid,
      count: seedComments.length,
    });

    // Get or create participant for the owner
    let pid = await getPidPromise(zid, uid!, true);
    if (pid === -1) {
      const rows = await addParticipant(zid, uid!);
      pid = rows[0].pid;
    }

    // Check if user is moderator
    const is_moderator = await isModerator(zid, uid!);

    const results: any[] = [];
    let lastInteractionTime = new Date(0);

    // Insert each comment
    for (const txt of seedComments) {
      try {
        if (!txt || txt.trim() === "") {
          results.push({
            txt,
            status: "skipped",
            reason: "empty_comment",
          });
          continue;
        }

        // Check for duplicates by querying directly
        const existingComments: any[] = await pg.queryP(
          `SELECT tid FROM comments WHERE zid = $1 AND txt = $2 LIMIT 1;`,
          [zid, txt]
        ) as any[];
        if (existingComments && existingComments.length > 0) {
          results.push({
            txt,
            status: "skipped",
            reason: "duplicate",
          });
          continue;
        }

        // Detect language
        const detections = await detectLanguage(txt);
        const detection = Array.isArray(detections) ? detections[0] : detections;
        const lang = detection.language;
        const lang_confidence = detection.confidence;

        // Seed comments are always auto-approved
        const active = true;
        const mod = polisTypes.mod.ok;

        // Insert comment
        const insertedComment: any = await pg.queryP(
          `INSERT INTO COMMENTS
          (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, $10, $11)
          RETURNING *;`,
          [
            pid,
            zid,
            txt,
            1, // velocity
            active,
            mod,
            uid,
            false, // anon
            true, // is_seed
            lang,
            lang_confidence,
          ]
        );

        const comment = insertedComment[0];
        const tid = comment.tid;
        const createdTimeMillis = safeTimestampToMillis(comment.created);
        const createdTime = new Date(createdTimeMillis);

        if (createdTime > lastInteractionTime) {
          lastInteractionTime = createdTime;
        }

        results.push({ txt, status: "success", tid });
      } catch (err: any) {
        logger.error("Failed to insert seed comment", { error: err, txt });
        results.push({
          txt,
          status: "error",
          reason: err.message || "unknown_error",
        });
      }
    }

    // Update conversation modified time
    if (lastInteractionTime > new Date(0)) {
      setTimeout(() => {
        updateConversationModifiedTime(zid, lastInteractionTime);
        updateLastInteractionTimeForConversation(zid, uid!);
      }, 100);
    }

    const successCount = results.filter((r) => r.status === "success").length;

    logger.info("Successfully generated and posted seed comments", {
      zid,
      totalGenerated: seedComments.length,
      successCount,
      results,
    });

    // 6. Return success response
    res.json({
      success: true,
      count: successCount,
      totalGenerated: seedComments.length,
      context,
      comments: seedComments,
      results,
    });
  } catch (error: any) {
    logger.error("Failed to generate seed comments", {
      zid,
      error: error.message,
      stack: error.stack,
    });

    // Determine appropriate error message
    let errorCode = "polis_err_generate_seed_comments";
    if (error.message?.includes("OpenAI API key")) {
      errorCode = "polis_err_openai_not_configured";
    } else if (error.message?.includes("Failed to generate")) {
      errorCode = "polis_err_openai_generation_failed";
    }

    failJson(res, 500, errorCode, error);
  }
}

interface SubmitSeedCommentsRequest extends Request {
  p: {
    zid: number;
    uid?: number;
    conversation_id: string;
  };
}

/**
 * POST /api/v3/conversations/:conversation_id/submit-seed-comments
 *
 * Marks seed comments as submitted for a conversation.
 */
export async function handle_POST_submit_seed_comments(
  req: SubmitSeedCommentsRequest,
  res: Response
): Promise<void> {
  logger.info("🎯 submit-seed-comments endpoint called", { 
    params: req.params, 
    p: req.p, 
    body: req.body 
  });
  
  const { zid, uid } = req.p;

  if (!zid) {
    logger.error("Missing zid in req.p", { p: req.p, params: req.params });
    failJson(res, 400, "polis_err_missing_zid");
    return;
  }

  try {
    // 1. Verify caller is conversation owner/moderator
    const isConvoOwner = await isOwner(zid, uid!);
    if (!isConvoOwner) {
      failJson(res, 403, "polis_err_submit_seed_comments_auth");
      return;
    }

    // 2. Update seed_comments_submitted flag
    await pg.queryP(
      `UPDATE conversations SET seed_comments_submitted = true WHERE zid = $1`,
      [zid]
    );

    logger.info("Successfully submitted seed comments", {
      zid,
    });

    // 3. Return success response
    res.json({
      success: true,
    });
  } catch (error: any) {
    logger.error("Failed to submit seed comments", {
      zid,
      error: error.message,
      stack: error.stack,
    });

    failJson(res, 500, "polis_err_submit_seed_comments", error);
  }
}