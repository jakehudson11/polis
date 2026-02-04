-- Add fields to track completion status of initiation sections
-- Migration: 000030_add_initiation_status_fields
-- Created: 2026-01-04

ALTER TABLE conversations
ADD COLUMN internal_information TEXT,
ADD COLUMN internal_information_submitted BOOLEAN DEFAULT FALSE,
ADD COLUMN seed_comments_submitted BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN conversations.internal_information IS 'Internal information text provided by administrator';
COMMENT ON COLUMN conversations.internal_information_submitted IS 'Whether internal information has been submitted';
COMMENT ON COLUMN conversations.seed_comments_submitted IS 'Whether seed comments have been submitted';








