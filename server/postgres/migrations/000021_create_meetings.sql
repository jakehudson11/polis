-- Migration: Create meetings table for tracking video meetings
-- Links meetings to deliberation groups (squads) and stores Recall.ai bot information

CREATE TABLE IF NOT EXISTS meetings (
    meeting_id SERIAL PRIMARY KEY,
    zid INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    topic_key TEXT,
    
    -- Meeting metadata
    platform VARCHAR(50) NOT NULL,  -- 'zoom', 'teams', 'meet'
    external_meeting_id VARCHAR(500),
    meeting_url VARCHAR(2000) NOT NULL,
    title VARCHAR(500),
    
    -- Recall.ai integration
    recall_bot_id VARCHAR(100),
    bot_status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'joining', 'in_call', 'done', 'failed'
    
    -- Timing
    scheduled_start TIMESTAMPTZ,
    actual_start TIMESTAMPTZ,
    actual_end TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key constraints
    CONSTRAINT fk_meeting_deliberation_group
        FOREIGN KEY (zid, group_id) 
        REFERENCES deliberation_groups(zid, group_id) 
        ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX idx_meetings_zid_group ON meetings(zid, group_id);
CREATE INDEX idx_meetings_bot_status ON meetings(bot_status);
CREATE INDEX idx_meetings_scheduled_start ON meetings(scheduled_start);
CREATE INDEX idx_meetings_recall_bot_id ON meetings(recall_bot_id) WHERE recall_bot_id IS NOT NULL;

-- Comments for documentation
COMMENT ON TABLE meetings IS 'Stores video meetings linked to deliberation groups (squads)';
COMMENT ON COLUMN meetings.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN meetings.group_id IS 'Deliberation group/squad ID';
COMMENT ON COLUMN meetings.topic_key IS 'Topic key being discussed (format: "job123#layer_id#cluster_id")';
COMMENT ON COLUMN meetings.platform IS 'Video meeting platform: zoom, teams, or meet';
COMMENT ON COLUMN meetings.recall_bot_id IS 'Recall.ai bot ID for this meeting';
COMMENT ON COLUMN meetings.bot_status IS 'Current status of the Recall bot';




