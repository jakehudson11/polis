-- Migration: Create meeting_oauth_tokens table for storing encrypted OAuth tokens
-- Allows users to authenticate their own Teams/Zoom/Meet accounts per conversation
-- Tokens are encrypted at rest using AES-256-GCM

CREATE TABLE IF NOT EXISTS meeting_oauth_tokens (
    token_id SERIAL PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    zid INTEGER NOT NULL REFERENCES conversations(zid) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,  -- 'teams', 'zoom', 'meet'
    
    -- Encrypted OAuth tokens (encrypted using AES-256-GCM)
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    
    -- Token metadata
    expires_at TIMESTAMPTZ,
    scope TEXT,
    platform_user_id VARCHAR(255),  -- Teams user ID, Zoom user ID, etc.
    
    -- Tracking
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    
    UNIQUE(uid, zid, platform)
);

-- Indexes for performance
CREATE INDEX idx_oauth_tokens_uid_zid ON meeting_oauth_tokens(uid, zid);
CREATE INDEX idx_oauth_tokens_expires ON meeting_oauth_tokens(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_tokens_platform ON meeting_oauth_tokens(platform) WHERE revoked_at IS NULL;

-- Comments for documentation
COMMENT ON TABLE meeting_oauth_tokens IS 'Stores encrypted OAuth tokens for users to create meetings via their own accounts';
COMMENT ON COLUMN meeting_oauth_tokens.uid IS 'Polis user ID';
COMMENT ON COLUMN meeting_oauth_tokens.zid IS 'Conversation ID - tokens are scoped per conversation';
COMMENT ON COLUMN meeting_oauth_tokens.platform IS 'Meeting platform: teams, zoom, or meet';
COMMENT ON COLUMN meeting_oauth_tokens.access_token_encrypted IS 'Encrypted access token (AES-256-GCM)';
COMMENT ON COLUMN meeting_oauth_tokens.refresh_token_encrypted IS 'Encrypted refresh token (AES-256-GCM)';
COMMENT ON COLUMN meeting_oauth_tokens.platform_user_id IS 'User ID from the platform (e.g., Teams user ID)';
COMMENT ON COLUMN meeting_oauth_tokens.revoked_at IS 'Timestamp when token was revoked (NULL if active)';



