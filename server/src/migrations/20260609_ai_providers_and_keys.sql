-- Polis AI Providers
CREATE TABLE IF NOT EXISTS polis_ai_providers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  base_url      TEXT,
  api_mode      TEXT NOT NULL DEFAULT 'openai',
  custom_headers JSONB DEFAULT '{}'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_polis_ai_providers_name ON polis_ai_providers(name);

-- Seed providers
INSERT INTO polis_ai_providers (name, display_name, base_url, api_mode)
VALUES
  ('openai',    'OpenAI',    'https://api.openai.com/v1',          'openai'),
  ('anthropic', 'Anthropic', 'https://api.anthropic.com/v1',       'anthropic'),
  ('google',    'Google',    'https://generativelanguage.googleapis.com/v1beta', 'gemini'),
  ('deepseek',  'DeepSeek',  'https://api.deepseek.com/v1',        'openai'),
  ('qwen',      'Qwen',      'https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai'),
  ('perplexity','Perplexity','https://api.perplexity.ai',           'openai')
ON CONFLICT (name) DO NOTHING;

-- Polis Provider API Keys (encrypted)
CREATE TABLE IF NOT EXISTS polis_provider_api_keys (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL UNIQUE,
  api_key       TEXT NOT NULL,
  base_url      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_polis_provider_api_keys_provider ON polis_provider_api_keys(provider);
