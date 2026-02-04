-- Migration: Create deliberation_group_members table for tracking group membership
-- This table tracks which participants are assigned to which deliberation groups (many-to-many)

CREATE TABLE IF NOT EXISTS deliberation_group_members (
    -- Composite primary key
    zid INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    
    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Composite primary key
    PRIMARY KEY (zid, group_id, pid),
    
    -- Foreign key constraints
    CONSTRAINT fk_conversation
        FOREIGN KEY (zid) 
        REFERENCES conversations(zid) 
        ON DELETE CASCADE,
    
    CONSTRAINT fk_deliberation_group
        FOREIGN KEY (zid, group_id) 
        REFERENCES deliberation_groups(zid, group_id) 
        ON DELETE CASCADE,
    
    CONSTRAINT fk_participant
        FOREIGN KEY (zid, pid) 
        REFERENCES participants(zid, pid) 
        ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX idx_deliberation_group_members_zid_pid ON deliberation_group_members(zid, pid);
CREATE INDEX idx_deliberation_group_members_zid_group_id ON deliberation_group_members(zid, group_id);
CREATE INDEX idx_deliberation_group_members_created_at ON deliberation_group_members(created_at);

-- Add comments for documentation
COMMENT ON TABLE deliberation_group_members IS 'Tracks which participants are assigned to which deliberation groups';
COMMENT ON COLUMN deliberation_group_members.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN deliberation_group_members.group_id IS 'Group ID (foreign key to deliberation_groups)';
COMMENT ON COLUMN deliberation_group_members.pid IS 'Participant ID (foreign key to participants)';






