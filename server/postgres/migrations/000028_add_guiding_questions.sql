-- Add guiding_questions field to store AI-generated questions
-- Migration: 000028_add_guiding_questions
-- Created: 2025-01-04

ALTER TABLE conversations 
ADD COLUMN guiding_questions TEXT;

COMMENT ON COLUMN conversations.guiding_questions IS 'AI-generated guiding questions for administrators to provide internal information';








