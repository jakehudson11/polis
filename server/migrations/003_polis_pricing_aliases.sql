-- ============================================================================
-- 003_polis_pricing_aliases.sql
-- Add pricing metadata columns, create pricing aliases table, and seed aliases.
-- Run via: docker exec -i polis-postgres psql -U polis -d polis < 003_polis_pricing_aliases.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Add missing columns to polis_ai_model_pricing
-- ---------------------------------------------------------------------------

ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS validation_status      TEXT DEFAULT 'unknown';
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS last_validated_at      TIMESTAMPTZ;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS validation_error       TEXT;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS validation_latency_ms  INTEGER;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS auto_update_enabled    BOOLEAN DEFAULT false;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS last_pricing_sync_at   TIMESTAMPTZ;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS pricing_sync_error     TEXT;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS context_window_tokens  INTEGER;
ALTER TABLE polis_ai_model_pricing ADD COLUMN IF NOT EXISTS max_output_tokens      INTEGER;

-- ---------------------------------------------------------------------------
-- Create polis_ai_pricing_aliases table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS polis_ai_pricing_aliases (
  id                  SERIAL PRIMARY KEY,
  model_name          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  aliased_model_name  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(model_name, provider)
);

-- ---------------------------------------------------------------------------
-- Seed initial pricing aliases
-- ---------------------------------------------------------------------------

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('deepseek-v4-pro', 'deepseek', 'deepseek/deepseek-v3.2')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('deepseek-v4-flash', 'deepseek', 'deepseek/deepseek-v3')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('qwen3.7-max', 'qwen', 'dashscope/qwen-max')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('qwen3.7-plus', 'qwen', 'dashscope/qwen-plus')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('gpt-image-2', 'openai', 'openai/gpt-image-2')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_pricing_aliases (model_name, provider, aliased_model_name)
VALUES ('gemini-3.1-flash-image', 'google', 'gemini/gemini-3.1-flash-image-preview')
ON CONFLICT (model_name, provider) DO NOTHING;
