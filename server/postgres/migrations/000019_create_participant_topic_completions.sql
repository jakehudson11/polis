-- Migration: Create participant_topic_completions table for tracking completed topics
-- This table tracks which topics each participant has completed deliberating on

CREATE TABLE IF NOT EXISTS participant_topic_completions (
    -- Composite primary key
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    topic_key TEXT NOT NULL,  -- Format: "job123#2#5" from DynamoDB
    
    -- Optional group context
    group_id INTEGER,  -- Which deliberation group they were in when completing
    
    -- Timestamp
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Composite primary key
    PRIMARY KEY (zid, pid, topic_key),
    
    -- Foreign key constraints
    CONSTRAINT fk_conversation
        FOREIGN KEY (zid) 
        REFERENCES conversations(zid) 
        ON DELETE CASCADE,
    
    CONSTRAINT fk_participant
        FOREIGN KEY (zid, pid) 
        REFERENCES participants(zid, pid) 
        ON DELETE CASCADE,
    
    CONSTRAINT fk_deliberation_group
        FOREIGN KEY (zid, group_id) 
        REFERENCES deliberation_groups(zid, group_id) 
        ON DELETE SET NULL
);

-- Create indexes for better query performance
CREATE INDEX idx_participant_topic_completions_zid_pid ON participant_topic_completions(zid, pid);
CREATE INDEX idx_participant_topic_completions_zid_topic_key ON participant_topic_completions(zid, topic_key);
CREATE INDEX idx_participant_topic_completions_completed_at ON participant_topic_completions(completed_at);

-- Add comments for documentation
COMMENT ON TABLE participant_topic_completions IS 'Tracks which topics each participant has completed deliberating on';
COMMENT ON COLUMN participant_topic_completions.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN participant_topic_completions.pid IS 'Participant ID (foreign key to participants)';
COMMENT ON COLUMN participant_topic_completions.topic_key IS 'Topic key from DynamoDB (format: "job123#layer_id#cluster_id")';
COMMENT ON COLUMN participant_topic_completions.group_id IS 'Optional deliberation group ID when topic was completed';






