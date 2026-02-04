-- Migration: Create meeting_attendance table for tracking participants and speaking time
-- Tracks who attended each meeting and calculates speaking time from transcript segments

CREATE TABLE IF NOT EXISTS meeting_attendance (
    meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    
    -- Participant identification
    recall_participant_id VARCHAR(100) NOT NULL,  -- ID from Recall.ai
    speaker_name VARCHAR(255),                   -- Name from meeting platform
    speaker_pid INTEGER,                         -- Linked to Polis participant (if matched)
    
    -- Attendance
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    
    -- Speaking stats (updated as transcripts come in)
    total_speaking_seconds NUMERIC(10, 2) DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    PRIMARY KEY (meeting_id, recall_participant_id)
    
    -- Note: speaker_pid is optional and references participants(pid) conceptually,
    -- but we can't create a foreign key since participants has composite PK (zid, pid)
    -- Matching will be done via application logic when linking speakers to participants
);

-- Indexes for performance
CREATE INDEX idx_meeting_attendance_meeting ON meeting_attendance(meeting_id);
CREATE INDEX idx_meeting_attendance_pid ON meeting_attendance(speaker_pid) WHERE speaker_pid IS NOT NULL;
CREATE INDEX idx_meeting_attendance_speaking_time ON meeting_attendance(meeting_id, total_speaking_seconds DESC);

-- Comments for documentation
COMMENT ON TABLE meeting_attendance IS 'Tracks meeting attendance and speaking time per participant';
COMMENT ON COLUMN meeting_attendance.recall_participant_id IS 'Participant ID from Recall.ai platform';
COMMENT ON COLUMN meeting_attendance.speaker_pid IS 'Linked Polis participant ID (if matched)';
COMMENT ON COLUMN meeting_attendance.total_speaking_seconds IS 'Total speaking time calculated from transcript segments';


