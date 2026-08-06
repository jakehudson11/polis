-- Delphi Report backup/fallback tiers
-- Idempotent: safe to run multiple times.
-- Sets backup (gpt-4o / openai) and fallback (gemini-2.5-pro / google)
-- tiers for the delphi_report use case while leaving the primary tier
-- (claude-sonnet-4-20250514 / anthropic) unchanged. Existing non-null
-- tiers are never overwritten.

-- Ensure the row exists (primary tier), mirroring 20260708_delphi_report_use_case.sql.
INSERT INTO polis_ai_use_case_config (use_case_key, primary_model, primary_provider, backup_model, backup_provider, fallback_model, fallback_provider, modality, updated_at)
VALUES ('delphi_report', 'claude-sonnet-4-20250514', 'anthropic', NULL, NULL, NULL, NULL, 'llm', NOW())
ON CONFLICT (use_case_key) DO NOTHING;

-- Fill only the missing backup/fallback tiers; never overwrite existing values.
UPDATE polis_ai_use_case_config
SET
  backup_model = COALESCE(backup_model, 'gpt-4o'),
  backup_provider = COALESCE(backup_provider, 'openai'),
  fallback_model = COALESCE(fallback_model, 'gemini-2.5-pro'),
  fallback_provider = COALESCE(fallback_provider, 'google'),
  updated_at = NOW()
WHERE use_case_key = 'delphi_report'
  AND (backup_model IS NULL OR backup_provider IS NULL OR fallback_model IS NULL OR fallback_provider IS NULL);
