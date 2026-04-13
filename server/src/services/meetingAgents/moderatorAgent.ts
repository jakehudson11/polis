import Config from "../../config";
import logger from "../../utils/logger";
import { BaseAgent, MeetingContext, TranscriptSegment } from "./baseAgent";
import { getAnthropicClient } from "../../utils/aiClients";
import { retryWithBackoff, AI_TIMEOUTS } from "../../utils/aiResilience";

export class ModeratorAgent extends BaseAgent {
  constructor() {
    super("moderator");
    // Singleton Anthropic client is obtained via getAnthropicClient()
  }

  /**
   * Generate a posing question based on topic and recent discussion
   */
  async generateQuestion(
    topic: string | null,
    recentTranscripts: TranscriptSegment[]
  ): Promise<string> {
    // Summarize recent discussion (last 20 segments or last 5 minutes)
    const recentText = recentTranscripts
      .slice(-20)
      .map((seg) => `${seg.speaker_name || "Speaker"}: ${seg.text}`)
      .join("\n");

    const topicContext = topic || "the current topic under deliberation";

    const prompt = `You are a meeting moderator for a deliberation squad discussing: ${topicContext}

The squad's goal is to provide well-thought-out recommendations on this topic.

Recent discussion:
${recentText || "The meeting has just started."}

Generate a single posing question (1-2 sentences) that will help the group:
1. Think more deeply about the topic
2. Consider different perspectives
3. Move toward actionable recommendations

The question should be open-ended and encourage thoughtful discussion. Be concise and direct.`;

    try {
      const anthropic = getAnthropicClient();
      const response = await retryWithBackoff(
        () => anthropic.messages.create({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
        { maxRetries: 2, timeout: AI_TIMEOUTS.STANDARD }
      );

      const question =
        response.content[0]?.type === "text"
          ? response.content[0].text.trim()
          : "How can we move forward with actionable recommendations?";

      logger.info("Generated moderator question", {
        topic,
        questionLength: question.length,
      });

      return question;
    } catch (error) {
      logger.error("Error generating moderator question", error);
      // Fallback question
      return "What perspectives should we consider to develop solid recommendations on this topic?";
    }
  }

  /**
   * Act on a meeting - generate and post a question
   */
  async act(meetingId: number): Promise<void> {
    try {
      // Check if we should act
      if (!(await this.shouldAct(meetingId))) {
        logger.debug("Moderator agent skipping - not time yet", { meetingId });
        return;
      }

      // Get meeting context
      const context = await this.getMeetingContext(meetingId);
      if (!context) {
        logger.warn("Meeting context not found", { meetingId });
        return;
      }

      // Get recent transcripts
      const state = await this.getAgentState(meetingId);
      const lastSegmentId = state?.last_transcript_segment_id;
      const transcripts = await this.getTranscripts(meetingId, lastSegmentId);

      // Generate question
      const question = await this.generateQuestion(
        context.topic_key,
        transcripts
      );

      // Post question
      await this.postComment(
        meetingId,
        question,
        true, // raise hand
        "scheduled",
        {
          topic: context.topic_key,
          interval_minutes: 10,
        }
      );

      // Update state
      const lastSegmentIdNew =
        transcripts.length > 0
          ? transcripts[transcripts.length - 1].segment_id
          : lastSegmentId;
      const actionCount = (state?.action_count || 0) + 1;

      await this.updateAgentState(meetingId, {
        last_action_at: new Date(),
        last_transcript_segment_id: lastSegmentIdNew,
        action_count: actionCount,
        context: {
          last_question: question,
          topic: context.topic_key,
        },
      });

      logger.info("Moderator agent acted", {
        meetingId,
        question,
        actionCount,
      });
    } catch (error) {
      logger.error("Error in moderator agent act", {
        error,
        meetingId,
      });
      throw error;
    }
  }
}



