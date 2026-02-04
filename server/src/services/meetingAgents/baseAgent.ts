import pgQuery from "../../db/pg-query";
import logger from "../../utils/logger";
import axios from "axios";
import Config from "../../config";

export interface TranscriptSegment {
  segment_id: number;
  meeting_id: number;
  speaker_pid: number | null;
  speaker_name: string | null;
  speaker_label: string | null;
  text: string;
  start_time: number;
  end_time: number;
  confidence: number | null;
  language: string;
  created_at: Date;
}

export interface MeetingContext {
  meeting_id: number;
  zid: number;
  group_id: number;
  topic_key: string | null;
  topic_name: string | null;
  platform: string;
  actual_start: Date | null;
}

const AGENT_INTERVAL_MINUTES = 10;
const AGENT_INTERVAL_MS = AGENT_INTERVAL_MINUTES * 60 * 1000;

export abstract class BaseAgent {
  protected agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * Check if agent should act (10 minutes passed since last action)
   */
  async shouldAct(meetingId: number): Promise<boolean> {
    const state = await this.getAgentState(meetingId);
    
    if (!state || !state.last_action_at) {
      return true; // First action
    }

    const lastAction = new Date(state.last_action_at);
    const now = new Date();
    const timeSinceLastAction = now.getTime() - lastAction.getTime();

    return timeSinceLastAction >= AGENT_INTERVAL_MS;
  }

  /**
   * Get agent state for a meeting
   */
  async getAgentState(meetingId: number): Promise<any> {
    const query = `
      SELECT * FROM meeting_agent_state
      WHERE meeting_id = $1 AND agent_id = $2
    `;
    const result = await pgQuery.queryP(query, [meetingId, this.agentId]) as any[];
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Update agent state
   */
  async updateAgentState(
    meetingId: number,
    updates: {
      last_action_at?: Date;
      last_transcript_segment_id?: number;
      action_count?: number;
      context?: any;
    }
  ): Promise<void> {
    const state = await this.getAgentState(meetingId);
    
    if (state) {
      // Update existing state
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.last_action_at !== undefined) {
        updateFields.push(`last_action_at = $${paramIndex++}`);
        values.push(updates.last_action_at);
      }
      if (updates.last_transcript_segment_id !== undefined) {
        updateFields.push(`last_transcript_segment_id = $${paramIndex++}`);
        values.push(updates.last_transcript_segment_id);
      }
      if (updates.action_count !== undefined) {
        updateFields.push(`action_count = $${paramIndex++}`);
        values.push(updates.action_count);
      }
      if (updates.context !== undefined) {
        updateFields.push(`context = $${paramIndex++}`);
        values.push(JSON.stringify(updates.context));
      }

      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

      values.push(meetingId, this.agentId);

      await pgQuery.queryP(
        `UPDATE meeting_agent_state 
         SET ${updateFields.join(", ")}
         WHERE meeting_id = $${paramIndex++} AND agent_id = $${paramIndex++}`,
        values
      );
    } else {
      // Create new state
      await pgQuery.queryP(
        `INSERT INTO meeting_agent_state (
          meeting_id, agent_id, last_action_at, last_transcript_segment_id, 
          action_count, context
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          meetingId,
          this.agentId,
          updates.last_action_at || null,
          updates.last_transcript_segment_id || null,
          updates.action_count || 0,
          JSON.stringify(updates.context || {}),
        ]
      );
    }
  }

  /**
   * Get transcript segments since last processed segment
   */
  async getTranscripts(
    meetingId: number,
    sinceSegmentId?: number
  ): Promise<TranscriptSegment[]> {
    let query: string;
    let params: any[];

    if (sinceSegmentId) {
      query = `
        SELECT * FROM transcript_segments
        WHERE meeting_id = $1 AND segment_id > $2
        ORDER BY segment_id ASC
      `;
      params = [meetingId, sinceSegmentId];
    } else {
      query = `
        SELECT * FROM transcript_segments
        WHERE meeting_id = $1
        ORDER BY segment_id ASC
      `;
      params = [meetingId];
    }

    const result = await pgQuery.queryP(query, params) as any[];
    return result.map((row) => ({
      segment_id: row.segment_id,
      meeting_id: row.meeting_id,
      speaker_pid: row.speaker_pid,
      speaker_name: row.speaker_name,
      speaker_label: row.speaker_label,
      text: row.text,
      start_time: parseFloat(row.start_time),
      end_time: parseFloat(row.end_time),
      confidence: row.confidence ? parseFloat(row.confidence) : null,
      language: row.language || "en",
      created_at: new Date(row.created_at),
    }));
  }

  /**
   * Get meeting context (topic, participants, etc.)
   */
  async getMeetingContext(meetingId: number): Promise<MeetingContext | null> {
    const query = `
      SELECT 
        m.meeting_id,
        m.zid,
        m.group_id,
        m.topic_key,
        m.platform,
        m.actual_start,
        dg.topic_key as group_topic_key
      FROM meetings m
      LEFT JOIN deliberation_groups dg ON m.zid = dg.zid AND m.group_id = dg.group_id
      WHERE m.meeting_id = $1
    `;
    const result = await pgQuery.queryP(query, [meetingId]) as any[];
    
    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      meeting_id: row.meeting_id,
      zid: row.zid,
      group_id: row.group_id,
      topic_key: row.topic_key || row.group_topic_key,
      topic_name: null, // Could be fetched from topics table if needed
      platform: row.platform,
      actual_start: row.actual_start ? new Date(row.actual_start) : null,
    };
  }

  /**
   * Post a comment to the meeting chat
   * Directly inserts into database and sends to Recall.ai (no HTTP call needed)
   */
  async postComment(
    meetingId: number,
    text: string,
    raiseHand: boolean = true,
    triggerType?: string,
    triggerContext?: any
  ): Promise<void> {
    try {
      const meetingQuery = `
        SELECT recall_bot_id, actual_start
        FROM meetings
        WHERE meeting_id = $1
      `;
      const meetingResult = await pgQuery.queryP(meetingQuery, [meetingId]) as any[];
      
      if (meetingResult.length === 0) {
        throw new Error("Meeting not found");
      }

      const botId = meetingResult[0].recall_bot_id;
      const meetingStart = meetingResult[0].actual_start;

      if (!botId) {
        throw new Error("Meeting bot not found");
      }

      // Calculate meeting time
      let meetingTimeSeconds = null;
      if (meetingStart) {
        const now = new Date();
        const start = new Date(meetingStart);
        meetingTimeSeconds = (now.getTime() - start.getTime()) / 1000;
      }

      // Insert comment record
      const insertCommentQuery = `
        INSERT INTO agent_comments (
          meeting_id,
          agent_id,
          comment_text,
          raise_hand,
          trigger_type,
          trigger_context,
          meeting_time_seconds
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING comment_id
      `;

      const commentResult = await pgQuery.queryP(insertCommentQuery, [
        meetingId,
        this.agentId,
        text,
        raiseHand,
        triggerType || null,
        triggerContext ? JSON.stringify(triggerContext) : null,
        meetingTimeSeconds,
      ]) as any[];

      const commentId = commentResult[0].comment_id;

      // Send to Recall.ai
      const { getRecallService } = await import("../recallService");
      const recallService = getRecallService();

      let delivered = false;
      let handRaised = false;
      let deliveryError = null;

      try {
        if (raiseHand) {
          // Note: Recall.ai may not support raiseHand directly
          // This is a placeholder - actual implementation depends on Recall.ai API
          logger.info("Hand raise requested", { botId, agentId: this.agentId });
        }

        await recallService.sendChatMessage(botId, text);
        delivered = true;
        handRaised = raiseHand; // Assume hand was raised if requested

        // Update comment record
        await pgQuery.queryP(
          `UPDATE agent_comments 
           SET delivered = TRUE, hand_raised = $1
           WHERE comment_id = $2`,
          [handRaised, commentId]
        );
      } catch (error) {
        deliveryError = error instanceof Error ? error.message : String(error);
        logger.error("Error sending agent comment to Recall.ai", {
          error: deliveryError,
          botId,
          commentId,
        });

        await pgQuery.queryP(
          `UPDATE agent_comments 
           SET delivery_error = $1
           WHERE comment_id = $2`,
          [deliveryError, commentId]
        );
      }

      logger.info("Agent comment posted", {
        agentId: this.agentId,
        meetingId,
        commentId,
        delivered,
        raiseHand,
      });
    } catch (error) {
      logger.error("Error posting agent comment", {
        error,
        agentId: this.agentId,
        meetingId,
      });
      throw error;
    }
  }

  /**
   * Abstract method to be implemented by each agent
   */
  abstract act(meetingId: number): Promise<void>;
}

