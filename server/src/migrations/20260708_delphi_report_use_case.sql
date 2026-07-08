-- Delphi Report use case config
-- Idempotent: safe to run multiple times
INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, backup_model, backup_provider, fallback_model, fallback_provider, modality, updated_at)
VALUES ('delphi_report', 'claude-sonnet-4-20250514', 'anthropic', NULL, NULL, NULL, NULL, 'llm', NOW())
ON CONFLICT (use_case_key) DO NOTHING;
