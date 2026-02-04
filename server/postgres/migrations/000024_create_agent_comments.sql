-- Migration: Create agent_comments table for tracking AI agent interventions
-- Stores comments posted by AI agents to meeting chat, with delivery status tracking

CREATE TABLE IF NOT EXISTS agent_comments (
    comment_id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    
    -- Agent identification
    agent_id VARCHAR(100) NOT NULL,  -- e.g., 'speaking-time-monitor', 'fact-checker', 'moderator'
    
    -- Content
    comment_text TEXT NOT NULL,
    raise_hand BOOLEAN DEFAULT TRUE,
    
    -- Trigger context (for debugging/analysis)
    trigger_type VARCHAR(50),  -- 'scheduled', 'analysis', 'conflict', 'fact-check', 'guidance'
    trigger_context JSONB,     -- Additional context from the agent (e.g., detected sentiment, fact-check results)
    
    -- Delivery tracking
    delivered BOOLEAN DEFAULT FALSE,
    hand_raised BOOLEAN DEFAULT FALSE,
    delivery_error TEXT,
    
    -- Timing
    meeting_time_seconds NUMERIC(10, 3),  -- When in the meeting this was posted (relative to meeting start)
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for queries
CREATE INDEX idx_agent_comments_meeting ON agent_comments(meeting_id, created_at);
CREATE INDEX idx_agent_comments_agent ON agent_comments(agent_id);
CREATE INDEX idx_agent_comments_trigger_type ON agent_comments(trigger_type);
CREATE INDEX idx_agent_comments_delivered ON agent_comments(delivered) WHERE delivered = FALSE;

-- Comments for documentation
COMMENT ON TABLE agent_comments IS 'Stores comments posted by AI agents to meeting chat';
COMMENT ON COLUMN agent_comments.agent_id IS 'Identifier for the AI agent (e.g., speaking-time-monitor)';
COMMENT ON COLUMN agent_comments.raise_hand IS 'Whether the bot should raise hand before posting';
COMMENT ON COLUMN agent_comments.trigger_type IS 'What triggered this comment (scheduled, analysis, etc.)';
COMMENT ON COLUMN agent_comments.trigger_context IS 'Additional context from the agent (JSON)';
COMMENT ON COLUMN agent_comments.meeting_time_seconds IS 'Time in meeting when comment was posted (relative to start)';




