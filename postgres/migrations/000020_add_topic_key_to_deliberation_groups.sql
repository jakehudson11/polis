-- Migration: Add topic_key column to deliberation_groups
-- This allows proper linking of squads to topics (currently encoded in squad name)

ALTER TABLE deliberation_groups 
ADD COLUMN IF NOT EXISTS topic_key TEXT;

CREATE INDEX IF NOT EXISTS idx_deliberation_groups_topic_key 
    ON deliberation_groups(zid, topic_key) 
    WHERE topic_key IS NOT NULL;

COMMENT ON COLUMN deliberation_groups.topic_key IS 'Topic key from DynamoDB (format: "job123#layer_id#cluster_id")';



