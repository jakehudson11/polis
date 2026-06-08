-- ============================================================================
-- 002_polis_ai_seed.sql
-- Seed initial AI model pricing and use case config data.
-- Run via: docker exec -i polis-postgres psql -U polis -d polis < 002_polis_ai_seed.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Seed initial models for Polis AI features
-- ---------------------------------------------------------------------------

-- OpenAI models
INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('gpt-4o-mini', 'openai', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('gpt-5.4', 'openai', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

-- Anthropic models
INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('claude-sonnet-4-20250514', 'anthropic', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('claude-haiku-4-5', 'anthropic', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

-- Google models
INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('gemini-3-flash-preview', 'google', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

-- DeepSeek models
INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('deepseek-v4-pro', 'deepseek', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

-- Qwen models
INSERT INTO polis_ai_model_pricing (model_name, provider, modality)
VALUES ('qwen3.7-max', 'qwen', 'llm')
ON CONFLICT (model_name, provider) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed use cases
-- ---------------------------------------------------------------------------

INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, modality)
VALUES ('seed_comment_generator', 'gpt-4o-mini', 'openai', 'llm')
ON CONFLICT (use_case_key) DO NOTHING;

INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, modality)
VALUES ('delphi_report', 'claude-sonnet-4-20250514', 'anthropic', 'llm')
ON CONFLICT (use_case_key) DO NOTHING;
