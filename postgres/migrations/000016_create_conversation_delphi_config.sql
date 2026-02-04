-- Migration: Create conversation_delphi_config table for storing Delphi layer configuration per conversation
-- This table stores which layer (0-3) to use for accessing topics in each conversation

CREATE TABLE IF NOT EXISTS conversation_delphi_config (
    -- Primary key
    zid INTEGER NOT NULL,
    
    -- Configuration
    layer_id INTEGER NOT NULL,  -- Which layer (0-3) to use for topics
    delphi_job_id TEXT,  -- Optional: specific Delphi job/run to use
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Primary key constraint
    PRIMARY KEY (zid),
    
    -- Foreign key constraint
    CONSTRAINT fk_conversation
        FOREIGN KEY (zid) 
        REFERENCES conversations(zid) 
        ON DELETE CASCADE,
    
    -- Validation
    CONSTRAINT layer_id_check CHECK (layer_id >= 0 AND layer_id <= 3)
);

-- Create index for better query performance
CREATE INDEX idx_conversation_delphi_config_zid ON conversation_delphi_config(zid);

-- Add comments for documentation
COMMENT ON TABLE conversation_delphi_config IS 'Stores Delphi layer configuration for each conversation';
COMMENT ON COLUMN conversation_delphi_config.zid IS 'Conversation ID (foreign key to conversations)';
COMMENT ON COLUMN conversation_delphi_config.layer_id IS 'Which layer (0-3) to use for accessing topics, where 0 is finest and 3 is coarsest';
COMMENT ON COLUMN conversation_delphi_config.delphi_job_id IS 'Optional ID of specific Delphi job/run to use for topics';





