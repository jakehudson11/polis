import axios, { AxiosError } from "axios";
import Config from "../config";
import logger from "../utils/logger";
import crypto from "crypto";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

interface OnlineMeetingConfig {
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
  participants?: {
    attendees?: Array<{ identity: { user: { id: string } } }>;
  };
}

interface OnlineMeetingResponse {
  id: string;
  joinWebUrl: string;
  subject?: string;
  startDateTime?: string;
  endDateTime?: string;
  participants?: any;
}

class TeamsService {
  private clientId: string;
  private clientSecret: string;
  private tenantId: string;
  private redirectUri: string;

  constructor() {
    if (!Config.teamsClientId || !Config.teamsClientSecret) {
      throw new Error("Teams OAuth credentials not configured");
    }
    this.clientId = Config.teamsClientId;
    this.clientSecret = Config.teamsClientSecret;
    this.tenantId = Config.teamsTenantId || "common";
    this.redirectUri = Config.teamsRedirectUri || "";
  }

  /**
   * Generate OAuth authorization URL
   * @param state - State parameter to include in OAuth flow (should include zid, group_id, etc.)
   */
  getOAuthUrl(state: string): string {
    const baseUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      response_mode: "query",
      scope: "OnlineMeetings.ReadWrite User.Read",
      state: state,
    });

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string): Promise<OAuthTokenResponse> {
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: code,
          grant_type: "authorization_code",
          redirect_uri: this.redirectUri,
          scope: "OnlineMeetings.ReadWrite User.Read",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Error exchanging code for token", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      });
      throw new Error(
        `Failed to exchange code for token: ${axiosError.response?.status}`
      );
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(
    refreshToken: string
  ): Promise<OAuthTokenResponse> {
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: "OnlineMeetings.ReadWrite User.Read",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Error refreshing access token", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      });
      throw new Error(
        `Failed to refresh access token: ${axiosError.response?.status}`
      );
    }
  }

  /**
   * Create an online meeting via Microsoft Graph API
   */
  async createOnlineMeeting(
    accessToken: string,
    config: OnlineMeetingConfig
  ): Promise<OnlineMeetingResponse> {
    const graphUrl = "https://graph.microsoft.com/v1.0/me/onlineMeetings";

    try {
      const response = await axios.post(
        graphUrl,
        {
          subject: config.subject || "Polis Meeting",
          startDateTime: config.startDateTime || new Date().toISOString(),
          endDateTime:
            config.endDateTime ||
            new Date(Date.now() + 60 * 60 * 1000).toISOString(), // Default 1 hour
          participants: config.participants,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Error creating online meeting", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      });
      throw new Error(
        `Failed to create meeting: ${axiosError.response?.status} - ${
          (axiosError.response?.data as any)?.error?.message ||
          axiosError.message
        }`
      );
    }
  }

  /**
   * Get user profile to extract platform_user_id
   */
  async getUserProfile(accessToken: string): Promise<{ id: string; mail?: string; displayName?: string }> {
    const graphUrl = "https://graph.microsoft.com/v1.0/me";

    try {
      const response = await axios.get(graphUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Error getting user profile", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
      });
      throw new Error(`Failed to get user profile: ${axiosError.response?.status}`);
    }
  }

  /**
   * Generate a secure state parameter for OAuth flow
   */
  generateState(zid: number, groupId: number, uid: number): string {
    const stateData = {
      zid,
      group_id: groupId,
      uid,
      nonce: crypto.randomBytes(16).toString("hex"),
      timestamp: Date.now(),
    };

    // Encode state as base64 JSON
    return Buffer.from(JSON.stringify(stateData)).toString("base64");
  }

  /**
   * Parse and validate state parameter
   */
  parseState(state: string): { zid: number; group_id: number; uid: number; nonce: string; timestamp: number } | null {
    try {
      const decoded = Buffer.from(state, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);

      // Validate state is not too old (5 minutes max)
      const maxAge = 5 * 60 * 1000; // 5 minutes
      if (Date.now() - parsed.timestamp > maxAge) {
        logger.warn("OAuth state expired", { timestamp: parsed.timestamp });
        return null;
      }

      return parsed;
    } catch (error) {
      logger.error("Error parsing OAuth state", { error });
      return null;
    }
  }
}

// Export singleton instance
let teamsServiceInstance: TeamsService | null = null;

export function getTeamsService(): TeamsService {
  if (!teamsServiceInstance) {
    teamsServiceInstance = new TeamsService();
  }
  return teamsServiceInstance;
}

export default TeamsService;



