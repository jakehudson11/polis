-- Migration: Create transcript_segments table for storing utterance-level transcripts
-- Stores real-time transcript data from Recall.ai with speaker identification and timestamps

CREATE TABLE IF NOT EXISTS transcript_segments (
    segment_id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    
    -- Speaker identification
    speaker_pid INTEGER,              -- Linked to Polis participant (if matched)
    speaker_label VARCHAR(100),       -- Recall's speaker label (e.g., "Speaker 1")
    speaker_name VARCHAR(255),        -- Name from meeting platform
    recall_participant_id VARCHAR(100), -- Recall participant ID for linking
    
    -- Content
    text TEXT NOT NULL,
    
    -- Timing (seconds from meeting start)
    start_time NUMERIC(10, 3) NOT NULL,
    end_time NUMERIC(10, 3) NOT NULL,
    
    -- Metadata
    confidence NUMERIC(4, 3),         -- Transcription confidence (0.000 to 1.000)
    language VARCHAR(10) DEFAULT 'en',
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Critical index for real-time polling: agents query with "WHERE meeting_id = X AND created_at > Y"
CREATE INDEX idx_transcript_segments_meeting_created 
    ON transcript_segments(meeting_id, created_at);

-- Indexes for other common queries
CREATE INDEX idx_transcript_segments_meeting_time 
    ON transcript_segments(meeting_id, start_time);
CREATE INDEX idx_transcript_segments_speaker_pid 
    ON transcript_segments(speaker_pid) WHERE speaker_pid IS NOT NULL;
CREATE INDEX idx_transcript_segments_recall_participant 
    ON transcript_segments(meeting_id, recall_participant_id);

-- Comments for documentation
COMMENT ON TABLE transcript_segments IS 'Stores utterance-level transcript segments from Recall.ai';
COMMENT ON COLUMN transcript_segments.speaker_pid IS 'Linked Polis participant ID (if matched)';
COMMENT ON COLUMN transcript_segments.speaker_label IS 'Recall.ai speaker label (e.g., "Speaker 1")';
COMMENT ON COLUMN transcript_segments.start_time IS 'Start time in seconds from meeting start';
COMMENT ON COLUMN transcript_segments.end_time IS 'End time in seconds from meeting start';
COMMENT ON COLUMN transcript_segments.confidence IS 'Transcription confidence score (0.000 to 1.000)';




