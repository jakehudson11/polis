-- Migration: Add conversation invitations and join request functionality
-- Date: 2026-01-05

-- Add join_mode column to conversations table
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS join_mode VARCHAR(20) DEFAULT 'open' CHECK (join_mode IN ('open', 'approval'));

-- Create invitations table for sharing conversation access
CREATE TABLE IF NOT EXISTS conversation_invitations (
    invitation_id SERIAL PRIMARY KEY,
    zid INTEGER NOT NULL REFERENCES conversations(zid) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(uid),
    invitation_token VARCHAR(64) UNIQUE,
    max_uses INTEGER DEFAULT NULL,  -- NULL means unlimited uses
    current_uses INTEGER DEFAULT 0,
    expires_at BIGINT DEFAULT NULL,  -- NULL means no expiration
    created BIGINT DEFAULT now_as_millis(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Create join requests table (for approval mode)
CREATE TABLE IF NOT EXISTS conversation_join_requests (
    request_id SERIAL PRIMARY KEY,
    zid INTEGER NOT NULL REFERENCES conversations(zid) ON DELETE CASCADE,
    uid INTEGER NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_at BIGINT DEFAULT now_as_millis(),
    reviewed_at BIGINT DEFAULT NULL,
    reviewed_by INTEGER REFERENCES users(uid),
    UNIQUE(zid, uid)  -- One join request per user per conversation
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS conversation_invitations_zid_idx ON conversation_invitations(zid);
CREATE INDEX IF NOT EXISTS conversation_invitations_token_idx ON conversation_invitations(invitation_token);
CREATE INDEX IF NOT EXISTS conversation_invitations_active_idx ON conversation_invitations(zid, is_active);

CREATE INDEX IF NOT EXISTS conversation_join_requests_zid_idx ON conversation_join_requests(zid);
CREATE INDEX IF NOT EXISTS conversation_join_requests_uid_idx ON conversation_join_requests(uid);
CREATE INDEX IF NOT EXISTS conversation_join_requests_status_idx ON conversation_join_requests(zid, status);






