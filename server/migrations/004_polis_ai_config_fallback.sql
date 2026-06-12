-- ============================================================================
-- 004_polis_ai_config_fallback.sql
-- Add fallback_model and fallback_provider columns to polis_ai_use_case_config.
-- Run via: docker exec -i polis-postgres psql -U polis -d polis < 004_polis_ai_config_fallback.sql
-- ============================================================================

ALTER TABLE polis_ai_use_case_config
  ADD COLUMN IF NOT EXISTS fallback_model TEXT;

ALTER TABLE polis_ai_use_case_config
  ADD COLUMN IF NOT EXISTS fallback_provider TEXT;
