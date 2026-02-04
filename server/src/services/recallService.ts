import axios, { AxiosError } from "axios";
import Config from "../config";
import logger from "../utils/logger";

interface BotConfig {
  meeting_url: string;
  webhook_url?: string;
  recording_config?: {
    transcript?: {
      provider?: {
        meeting_captions?: Record<string, never>;
        recallai_streaming?: {
          mode?: "prioritize_low_latency" | "prioritize_accuracy";
        };
      };
    };
    realtime_endpoints?: Array<{
      type: string;
      url: string;
      events: string[];
    }>;
  };
}

interface BotStatus {
  id: string;
  status: string;
  meeting_url?: string;
  recording?: {
    id?: string;
  };
}

interface CreateBotResponse {
  id: string;
  status: string;
}

class RecallService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    if (!Config.recallApiKey) {
      throw new Error("RECALL_API_KEY is not configured");
    }
    this.apiKey = Config.recallApiKey;
    this.baseUrl = Config.recallApiBaseUrl || "https://us-west-2.recall.ai/api/v1";
  }

  private async makeRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    endpoint: string,
    data?: any
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      logger.debug("Recall.ai API request", { 
        method, 
        url, 
        hasData: !!data,
        dataKeys: data ? Object.keys(data) : [],
        webhookUrl: data?.webhook_url 
      });
      const response = await axios({
        method,
        url,
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        data,
      });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const errorData = axiosError.response?.data as any;
      logger.error("Recall.ai API error", {
        method,
        endpoint,
        status: axiosError.response?.status,
        data: errorData,
        error: axiosError.message,
      });
      throw new Error(
        `Recall.ai API error: ${axiosError.response?.status} - ${
          errorData?.message || axiosError.message
        }`
      );
    }
  }

  /**
   * Create a bot to join a meeting with live transcription enabled
   * Uses Recall.ai's built-in native transcription service (no third-party required)
   */
  async createBot(
    meetingUrl: string,
    webhookUrl?: string,
    transcriptionMode: "prioritize_low_latency" | "prioritize_accuracy" = "prioritize_low_latency"
  ): Promise<{ bot_id: string }> {
    const config: BotConfig = {
      meeting_url: meetingUrl,
      recording_config: {
        transcript: {
          provider: {
            // Use Recall.ai's built-in native transcription
            // No third-party provider credentials needed
            recallai_streaming: {
              mode: transcriptionMode, // "prioritize_low_latency" for real-time or "prioritize_accuracy" for post-meeting
            },
          },
        },
      },
    };

    // Configure real-time webhook endpoints for live transcription
    // Only include if webhook URL is provided and not localhost (Recall.ai blocks localhost)
    if (webhookUrl && !webhookUrl.includes("localhost") && !webhookUrl.includes("127.0.0.1")) {
      config.webhook_url = webhookUrl;
      
      // Configure realtime_endpoints for live transcription events
      config.recording_config!.realtime_endpoints = [
        {
          type: "webhook",
          url: webhookUrl,
          events: [
            "transcript.data",        // Final transcript segments
            "transcript.partial_data", // Partial/streaming transcript data
            "transcript.done",        // Transcription complete
          ],
        },
      ];
    } else {
      // Fallback to meeting_captions if no webhook (platform-native captions)
      // This is less reliable but works without webhook configuration
      config.recording_config!.transcript!.provider = {
        meeting_captions: {},
      };
      logger.warn("Using platform-native captions (meeting_captions) - webhook URL not available for real-time transcription");
    }

    const response = await this.makeRequest<CreateBotResponse>(
      "POST",
      "/bot/",
      config
    );

    return { bot_id: response.id };
  }

  /**
   * Get bot status and details
   */
  async getBot(botId: string): Promise<BotStatus> {
    return this.makeRequest<BotStatus>("GET", `/bot/${botId}/`);
  }

  /**
   * Remove/delete a bot
   */
  async removeBot(botId: string): Promise<void> {
    await this.makeRequest("DELETE", `/bot/${botId}/`);
  }

  /**
   * Send a chat message to the meeting
   */
  async sendChatMessage(botId: string, message: string): Promise<void> {
    await this.makeRequest("POST", `/bot/${botId}/chat/`, {
      message,
    });
  }

  /**
   * Raise hand in the meeting (visual signal)
   * Note: Recall.ai may not support this directly - this is a placeholder
   * that may need to be implemented via platform-specific APIs
   */
  async raiseHand(botId: string): Promise<void> {
    // Recall.ai doesn't have a direct "raise hand" API endpoint
    // This may need to be implemented via platform-specific bot actions
    // For now, we'll log it - the actual implementation may require
    // platform-specific bot configurations or custom actions
    logger.info("Raise hand requested", { botId });
    // TODO: Implement platform-specific hand raise if Recall.ai adds support
    // or use platform-specific bot actions
  }

  /**
   * Lower hand in the meeting
   */
  async lowerHand(botId: string): Promise<void> {
    logger.info("Lower hand requested", { botId });
    // TODO: Implement platform-specific hand lower if Recall.ai adds support
  }
}

// Export singleton instance
let recallServiceInstance: RecallService | null = null;

export function getRecallService(): RecallService {
  if (!recallServiceInstance) {
    recallServiceInstance = new RecallService();
  }
  return recallServiceInstance;
}

export default RecallService;


