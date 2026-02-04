import pgQuery from "../db/pg-query";
import logger from "../utils/logger";
import { encryptToken, decryptToken } from "../utils/tokenEncryption";

interface TokenData {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  platformUserId?: string | null;
}

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  platformUserId: string | null;
  lastUsedAt: Date | null;
}

class MeetingOAuthService {
  /**
   * Store OAuth tokens for a user/conversation/platform combination
   */
  async storeToken(
    uid: number,
    zid: number,
    platform: string,
    tokenData: TokenData
  ): Promise<void> {
    try {
      const accessTokenEncrypted = encryptToken(tokenData.accessToken);
      const refreshTokenEncrypted = tokenData.refreshToken
        ? encryptToken(tokenData.refreshToken)
        : null;

      await pgQuery.queryP(
        `
        INSERT INTO meeting_oauth_tokens (
          uid, zid, platform,
          access_token_encrypted, refresh_token_encrypted,
          expires_at, scope, platform_user_id,
          last_used_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
        ON CONFLICT (uid, zid, platform)
        DO UPDATE SET
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, meeting_oauth_tokens.refresh_token_encrypted),
          expires_at = EXCLUDED.expires_at,
          scope = EXCLUDED.scope,
          platform_user_id = EXCLUDED.platform_user_id,
          last_used_at = CURRENT_TIMESTAMP,
          revoked_at = NULL
        `,
        [
          uid,
          zid,
          platform,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          tokenData.expiresAt || null,
          tokenData.scope || null,
          tokenData.platformUserId || null,
        ]
      );

      logger.info("Stored OAuth token", { uid, zid, platform });
    } catch (error) {
      logger.error("Error storing OAuth token", { error, uid, zid, platform });
      throw error;
    }
  }

  /**
   * Get OAuth token for a user/conversation/platform
   * Returns null if not found or revoked
   */
  async getToken(
    uid: number,
    zid: number,
    platform: string
  ): Promise<StoredToken | null> {
    try {
      const result = await pgQuery.queryP(
        `
        SELECT 
          access_token_encrypted,
          refresh_token_encrypted,
          expires_at,
          scope,
          platform_user_id,
          last_used_at
        FROM meeting_oauth_tokens
        WHERE uid = $1 AND zid = $2 AND platform = $3
          AND revoked_at IS NULL
        `,
        [uid, zid, platform]
      ) as any[];

      if (result.length === 0) {
        return null;
      }

      const row = result[0];

      // Decrypt tokens
      const accessToken = decryptToken(row.access_token_encrypted);
      const refreshToken = row.refresh_token_encrypted
        ? decryptToken(row.refresh_token_encrypted)
        : null;

      return {
        accessToken,
        refreshToken,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        scope: row.scope,
        platformUserId: row.platform_user_id,
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      };
    } catch (error) {
      logger.error("Error getting OAuth token", { error, uid, zid, platform });
      throw error;
    }
  }

  /**
   * Check if token exists and is valid (not expired, not revoked)
   */
  async hasValidToken(
    uid: number,
    zid: number,
    platform: string
  ): Promise<boolean> {
    const token = await this.getToken(uid, zid, platform);
    if (!token) {
      return false;
    }

    // Check expiration (with 5 minute buffer)
    if (token.expiresAt) {
      const now = new Date();
      const buffer = 5 * 60 * 1000; // 5 minutes
      if (token.expiresAt.getTime() - buffer < now.getTime()) {
        return false;
      }
    }

    return true;
  }

  /**
   * Update last_used_at timestamp
   */
  async updateLastUsed(
    uid: number,
    zid: number,
    platform: string
  ): Promise<void> {
    await pgQuery.queryP(
      `
      UPDATE meeting_oauth_tokens
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE uid = $1 AND zid = $2 AND platform = $3
        AND revoked_at IS NULL
      `,
      [uid, zid, platform]
    );
  }

  /**
   * Revoke a token (mark as revoked)
   */
  async revokeToken(
    uid: number,
    zid: number,
    platform: string
  ): Promise<void> {
    await pgQuery.queryP(
      `
      UPDATE meeting_oauth_tokens
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE uid = $1 AND zid = $2 AND platform = $3
        AND revoked_at IS NULL
      `,
      [uid, zid, platform]
    );

    logger.info("Revoked OAuth token", { uid, zid, platform });
  }

  /**
   * Update token data (e.g., after refresh)
   */
  async updateToken(
    uid: number,
    zid: number,
    platform: string,
    tokenData: Partial<TokenData>
  ): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (tokenData.accessToken) {
      updates.push(`access_token_encrypted = $${paramIndex++}`);
      values.push(encryptToken(tokenData.accessToken));
    }

    if (tokenData.refreshToken !== undefined) {
      if (tokenData.refreshToken) {
        updates.push(`refresh_token_encrypted = $${paramIndex++}`);
        values.push(encryptToken(tokenData.refreshToken));
      } else {
        updates.push(`refresh_token_encrypted = NULL`);
      }
    }

    if (tokenData.expiresAt !== undefined) {
      updates.push(`expires_at = $${paramIndex++}`);
      values.push(tokenData.expiresAt || null);
    }

    if (tokenData.scope !== undefined) {
      updates.push(`scope = $${paramIndex++}`);
      values.push(tokenData.scope || null);
    }

    if (updates.length === 0) {
      return;
    }

    updates.push(`last_used_at = CURRENT_TIMESTAMP`);

    values.push(uid, zid, platform);

    await pgQuery.queryP(
      `
      UPDATE meeting_oauth_tokens
      SET ${updates.join(", ")}
      WHERE uid = $${paramIndex++} AND zid = $${paramIndex++} AND platform = $${paramIndex++}
        AND revoked_at IS NULL
      `,
      values
    );
  }
}

// Export singleton instance
let meetingOAuthServiceInstance: MeetingOAuthService | null = null;

export function getMeetingOAuthService(): MeetingOAuthService {
  if (!meetingOAuthServiceInstance) {
    meetingOAuthServiceInstance = new MeetingOAuthService();
  }
  return meetingOAuthServiceInstance;
}

export default MeetingOAuthService;



