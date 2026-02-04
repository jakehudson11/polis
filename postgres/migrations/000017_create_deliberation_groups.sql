-- Migration: Create deliberation_groups table for storing deliberation groups
-- This table stores deliberation groups that can be created multiple times per conversation

CREATE TABLE IF NOT EXISTS deliberation_groups (
    -- Composite primary key
    zid INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    
    -- Optional group name/description
    name VARCHAR(500),
    
    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Composite primary key
    PRIMARY KEY (zid, group_id),
    
    -- Foreign key constraint
    CONSTRAINT fk_conversation
        FOREIGN KEY (zid) 
        REFERENCES conversations(zid) 
        ON DELETE CASCADE,
    
    -- Validation
    CONSTRAINT group_id_check CHECK (group_id > 0)
);

-- Create indexes for better query performance
CREATE INDEX idx_deliberation_groups_zid ON deliberation_groups(zid);
CREATE INDEX idx_deliberation_groups_created_at ON deliberation_groups(created_at);

-- Add comments for documentation
COMMENT ON TABLE deliberation_groups IS 'Stores deliberation groups that can be created multiple times per conversation';
COMMENT ON COLUMN deliberation_groups.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN deliberation_groups.group_id IS 'Group ID, auto-incremented per conversation';
COMMENT ON COLUMN deliberation_groups.name IS 'Optional group name or description';





