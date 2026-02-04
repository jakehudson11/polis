import Anthropic from "@anthropic-ai/sdk";
import Config from "../../config";
import logger from "../../utils/logger";
import pgQuery from "../../db/pg-query";
import { BaseAgent } from "./baseAgent";

interface SpeakingTimeParticipant {
  speaker_pid: number | null;
  speaker_name: string | null;
  total_speaking_seconds: number;
  percentage: number;
}

export class SpeakingTimeMonitorAgent extends BaseAgent {
  private anthropic: Anthropic;

  constructor() {
    super("speaking-time-monitor");
    if (!Config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    this.anthropic = new Anthropic({
      apiKey: Config.anthropicApiKey,
    });
  }

  /**
   * Get speaking time statistics for a meeting
   */
  async getSpeakingTime(meetingId: number): Promise<{
    participants: SpeakingTimeParticipant[];
    totalDuration: number;
  }> {
    const query = `
      SELECT 
        speaker_pid,
        speaker_name,
        SUM(total_speaking_seconds) as total_speaking_seconds
      FROM meeting_attendance
      WHERE meeting_id = $1
        AND total_speaking_seconds > 0
      GROUP BY speaker_pid, speaker_name
      ORDER BY total_speaking_seconds DESC
    `;

    const result = await pgQuery.queryP(query, [meetingId]) as any[];

    const participants = result.map((row) => ({
      speaker_pid: row.speaker_pid,
      speaker_name: row.speaker_name || "Unknown",
      total_speaking_seconds: parseFloat(row.total_speaking_seconds) || 0,
      percentage: 0, // Will calculate below
    }));

    const totalDuration = participants.reduce(
      (sum, p) => sum + p.total_speaking_seconds,
      0
    );

    // Calculate percentages
    if (totalDuration > 0) {
      participants.forEach((p) => {
        p.percentage = (p.total_speaking_seconds / totalDuration) * 100;
      });
    }

    return {
      participants,
      totalDuration,
    };
  }

  /**
   * Format speaking time message using Claude for natural language
   */
  async formatSpeakingTimeMessage(
    participants: SpeakingTimeParticipant[]
  ): Promise<string> {
    if (participants.length === 0) {
      return "📊 Speaking Time: No speaking data available yet.";
    }

    // Sort by percentage descending
    const sorted = [...participants].sort((a, b) => b.percentage - a.percentage);

    // Create a simple formatted list
    const lines = sorted.map((p, index) => {
      const name = p.speaker_name || `Speaker ${index + 1}`;
      const percentage = p.percentage.toFixed(1);
      const minutes = Math.floor(p.total_speaking_seconds / 60);
      const seconds = Math.floor(p.total_speaking_seconds % 60);
      return `${name}: ${percentage}% (${minutes}m ${seconds}s)`;
    });

    const message = `📊 Speaking Time Update:\n\n${lines.join("\n")}`;

    // Use Claude to make it more natural if desired
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `Format this speaking time data into a friendly, concise message for a meeting chat:\n\n${message}\n\nMake it brief and encouraging balanced participation.`,
          },
        ],
      });

      const formatted =
        response.content[0]?.type === "text"
          ? response.content[0].text.trim()
          : message;

      return formatted;
    } catch (error) {
      logger.warn("Error formatting speaking time with Claude, using default", error);
      return message;
    }
  }

  /**
   * Act on a meeting - post speaking time statistics
   */
  async act(meetingId: number): Promise<void> {
    try {
      // Check if we should act
      if (!(await this.shouldAct(meetingId))) {
        logger.debug("Speaking time monitor agent skipping - not time yet", { meetingId });
        return;
      }

      // Get speaking time statistics
      const { participants, totalDuration } = await this.getSpeakingTime(meetingId);

      if (participants.length === 0 || totalDuration === 0) {
        logger.debug("Speaking time monitor agent skipping - no speaking data", { meetingId });
        return;
      }

      // Format message
      const message = await this.formatSpeakingTimeMessage(participants);

      // Post message
      await this.postComment(
        meetingId,
        message,
        true, // raise hand
        "scheduled",
        {
          participants: participants.map((p) => ({
            name: p.speaker_name,
            percentage: p.percentage,
            seconds: p.total_speaking_seconds,
          })),
          total_duration: totalDuration,
          interval_minutes: 10,
        }
      );

      // Update state
      const state = await this.getAgentState(meetingId);
      const actionCount = (state?.action_count || 0) + 1;

      await this.updateAgentState(meetingId, {
        last_action_at: new Date(),
        action_count: actionCount,
        context: {
          last_posted_at: new Date().toISOString(),
          participant_count: participants.length,
        },
      });

      logger.info("Speaking time monitor agent acted", {
        meetingId,
        participantCount: participants.length,
        actionCount,
      });
    } catch (error) {
      logger.error("Error in speaking time monitor agent act", {
        error,
        meetingId,
      });
      throw error;
    }
  }
}



