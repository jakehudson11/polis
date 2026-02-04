-- Migration: Create api_keys table for authenticating external agents (n8n, etc.)
-- Stores hashed API keys for secure authentication

CREATE TABLE IF NOT EXISTS api_keys (
    key_id SERIAL PRIMARY KEY,
    key_hash VARCHAR(64) NOT NULL UNIQUE,  -- SHA-256 hash of the API key
    name VARCHAR(100) NOT NULL,             -- e.g., "n8n-production", "dev-agent"
    
    -- Permissions (for future expansion)
    can_read_transcripts BOOLEAN DEFAULT TRUE,
    can_post_comments BOOLEAN DEFAULT TRUE,
    can_manage_meetings BOOLEAN DEFAULT TRUE,
    
    -- Metadata
    created_by INTEGER REFERENCES users(uid) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);

-- Indexes
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_active ON api_keys(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_api_keys_name ON api_keys(name);

-- Comments for documentation
COMMENT ON TABLE api_keys IS 'Stores API keys for authenticating external agents (n8n workflows, etc.)';
COMMENT ON COLUMN api_keys.key_hash IS 'SHA-256 hash of the API key (never store plaintext)';
COMMENT ON COLUMN api_keys.name IS 'Human-readable name for the API key';
COMMENT ON COLUMN api_keys.can_read_transcripts IS 'Permission to read transcript data';
COMMENT ON COLUMN api_keys.can_post_comments IS 'Permission to post agent comments';
COMMENT ON COLUMN api_keys.can_manage_meetings IS 'Permission to create/manage meetings';




