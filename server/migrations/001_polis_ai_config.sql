-- ============================================================================
-- 001_polis_ai_config.sql
-- Create tables for Polis AI model pricing and use case configuration.
-- Run via: docker exec -i polis-postgres psql -U polis -d polis < 001_polis_ai_config.sql
-- ============================================================================

-- polis_ai_model_pricing: tracks AI models available to Polis
CREATE TABLE IF NOT EXISTS polis_ai_model_pricing (
  id                      SERIAL PRIMARY KEY,
  model_name              TEXT NOT NULL,
  provider                TEXT NOT NULL,
  input_cost_per_million  NUMERIC NOT NULL DEFAULT 0,
  output_cost_per_million NUMERIC NOT NULL DEFAULT 0,
  modality                TEXT NOT NULL DEFAULT 'llm',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(model_name, provider)
);

-- polis_ai_use_case_config: which model to use for each Polis AI feature
CREATE TABLE IF NOT EXISTS polis_ai_use_case_config (
  id               SERIAL PRIMARY KEY,
  use_case_key     TEXT NOT NULL UNIQUE,
  primary_model    TEXT NOT NULL,
  primary_provider TEXT NOT NULL,
  backup_model     TEXT,
  backup_provider  TEXT,
  modality         TEXT NOT NULL DEFAULT 'llm',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
