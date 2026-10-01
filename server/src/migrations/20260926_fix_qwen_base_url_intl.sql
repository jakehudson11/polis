-- Fix Qwen base_url: China DashScope endpoint -> international endpoint
-- Idempotent: safe to run multiple times.
--
-- WHY: polis_ai_providers seeded the 'qwen' row with the China DashScope host
-- (dashscope.aliyuncs.com). International DashScope API keys are rejected against
-- the CN host. Polis's own defaults are already intl -- aiClients.ts falls back to
-- https://dashscope-intl.aliyuncs.com/compatible-mode/v1 and docker-compose.yml sets
-- QWEN_BASE_URL to that same value -- so the stored row is the outlier. This
-- migration brings already-provisioned databases in line with the runtime default.
--
-- SAFETY: the WHERE guard matches only base_urls whose host literally contains
-- 'dashscope.aliyuncs.com'. The corrected intl URL ('dashscope-intl.aliyuncs.com')
-- does NOT contain that substring -- the '-intl' sits between 'dashscope' and the
-- dot -- so an already-fixed row is never re-matched and re-runs are no-ops.
-- polis_ai_providers has no scope column and name is UNIQUE, so name is the whole key.

UPDATE polis_ai_providers
SET
  base_url = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  updated_at = NOW()
WHERE name = 'qwen'
  AND base_url LIKE '%dashscope.aliyuncs.com%';
