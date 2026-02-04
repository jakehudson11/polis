-- Migration: Create meeting_agent_state table for tracking AI agent actions
-- Prevents duplicate actions and tracks agent state per meeting

CREATE TABLE IF NOT EXISTS meeting_agent_state (
    state_id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    agent_id VARCHAR(100) NOT NULL,  -- 'moderator', 'fact-checker', 'speaking-time-monitor'
    
    -- State tracking
    last_action_at TIMESTAMPTZ,
    last_transcript_segment_id INTEGER,  -- Last processed segment ID
    action_count INTEGER DEFAULT 0,
    
    -- Agent-specific context (JSONB)
    context JSONB DEFAULT '{}',  -- e.g., {"last_question": "...", "checked_facts": [...]}
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(meeting_id, agent_id)
);

-- Indexes for performance
CREATE INDEX idx_agent_state_meeting ON meeting_agent_state(meeting_id);
CREATE INDEX idx_agent_state_last_action ON meeting_agent_state(last_action_at) WHERE last_action_at IS NOT NULL;
CREATE INDEX idx_agent_state_agent ON meeting_agent_state(agent_id);

-- Comments for documentation
COMMENT ON TABLE meeting_agent_state IS 'Tracks AI agent state and actions for each meeting to prevent duplicates and maintain context';
COMMENT ON COLUMN meeting_agent_state.meeting_id IS 'Meeting this agent is monitoring';
COMMENT ON COLUMN meeting_agent_state.agent_id IS 'Agent identifier: moderator, fact-checker, or speaking-time-monitor';
COMMENT ON COLUMN meeting_agent_state.last_action_at IS 'Timestamp of last action taken by this agent';
COMMENT ON COLUMN meeting_agent_state.last_transcript_segment_id IS 'Last transcript segment ID processed (for incremental processing)';
COMMENT ON COLUMN meeting_agent_state.context IS 'Agent-specific context stored as JSON (e.g., checked facts, last question)';



