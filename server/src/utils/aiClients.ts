import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { decrypt } from './encryption';
import pg from '../db/pg-query';

function decryptApiKey(encrypted: string): string {
  try {
    return decrypt(encrypted);
  } catch {
    // If decryption fails, the key might be stored as plaintext (legacy)
    // or encrypted with a different key. Return as-is.
    return encrypted;
  }
}

async function resolvePolisProviderCredentials(provider: string): Promise<{ apiKey: string; baseUrl?: string } | null> {
  try {
    const rows = await pg.queryP(
      'SELECT api_key, base_url FROM polis_provider_api_keys WHERE provider = $1 AND is_active = true',
      [provider.toLowerCase().trim()]
    );
    if (rows.length > 0) {
      let baseUrl: string | undefined = rows[0].base_url || undefined;
      if (!baseUrl) {
        try {
          const providerRows = await pg.queryP(
            'SELECT base_url FROM polis_ai_providers WHERE name = $1 AND is_active = true ORDER BY id LIMIT 1',
            [provider.toLowerCase().trim()]
          );
          if (providerRows.length > 0 && providerRows[0].base_url) {
            baseUrl = providerRows[0].base_url;
          }
        } catch {
          // Silently ignore — provider table lookup is best-effort
        }
      }
      return {
        apiKey: decryptApiKey(rows[0].api_key),
        baseUrl,
      };
    }
    console.warn(`[aiClients] No active API key found in DB for provider "${provider}"`);
  } catch (err) {
    console.warn(`[aiClients] Failed to load API key for ${provider} from DB:`, (err as Error).message);
  }

  // Fall back to env vars (matching Polis env var conventions)
  const normalized = provider.toLowerCase().trim();
  let envKey: string | undefined;
  let envUrl: string | undefined;

  if (normalized === 'openai') envKey = process.env.OPENAI_API_KEY;
  else if (normalized === 'anthropic') envKey = process.env.ANTHROPIC_API_KEY;
  else if (normalized === 'google' || normalized === 'gemini') envKey = process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  else if (normalized === 'deepseek') envKey = process.env.DEEPSEEK_API_KEY;
  else if (normalized === 'qwen') envKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  else envKey = process.env[`${normalized.toUpperCase()}_API_KEY`];

  envUrl = process.env[`${normalized.toUpperCase()}_BASE_URL`];

  if (envKey) {
    return { apiKey: envKey, baseUrl: envUrl || undefined };
  }

  return null;
}

export async function createClientForProvider(provider: string): Promise<OpenAI | Anthropic | GoogleGenerativeAI> {
  const creds = await resolvePolisProviderCredentials(provider);
  if (!creds) throw new Error(`No API key configured for "${provider}". Add it via Agora Superuser AI Config → Polis → Available Providers → API Key.`);

  if (provider === 'google') return new GoogleGenerativeAI(creds.apiKey);
  if (provider === 'anthropic') return new Anthropic({ apiKey: creds.apiKey, maxRetries: 0 });
  // OpenAI-compatible (openai, deepseek, qwen, etc.)
  return new OpenAI({ apiKey: creds.apiKey, baseURL: creds.baseUrl || undefined, maxRetries: 0 });
}

let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;
let geminiClient: GoogleGenerativeAI | null = null;
let deepseekClient: OpenAI | null = null;
let qwenClient: OpenAI | null = null;

export function getOpenAIClient(creds?: { apiKey?: string; baseUrl?: string }): OpenAI {
  const apiKey = creds?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  // If explicit creds provided and differ from cached, return a fresh client
  if (creds?.apiKey && creds.apiKey !== process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: creds.apiKey, baseURL: creds.baseUrl || undefined, maxRetries: 0 });
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey, maxRetries: 0 });
  }
  return openaiClient;
}

export function getAnthropicClient(creds?: { apiKey?: string; baseUrl?: string }): Anthropic {
  const apiKey = creds?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  // If explicit creds provided and differ from cached, return a fresh client
  if (creds?.apiKey && creds.apiKey !== process.env.ANTHROPIC_API_KEY) {
    return new Anthropic({ apiKey: creds.apiKey, maxRetries: 0 });
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return anthropicClient;
}

export function getGeminiClient(creds?: { apiKey?: string; baseUrl?: string }): GoogleGenerativeAI {
  const apiKey = creds?.apiKey || process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY is not configured');
  }
  // If explicit creds provided and differ from cached, return a fresh client
  if (creds?.apiKey && creds.apiKey !== process.env.GOOGLE_GEMINI_API_KEY) {
    return new GoogleGenerativeAI(creds.apiKey);
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(apiKey);
  }
  return geminiClient;
}

export function getDeepSeekClient(creds?: { apiKey?: string; baseUrl?: string }): OpenAI {
  const apiKey = creds?.apiKey || process.env.DEEPSEEK_API_KEY;
  const baseUrl = creds?.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured');
  }
  // If explicit creds provided and differ from cached, return a fresh client
  if (creds?.apiKey && creds.apiKey !== process.env.DEEPSEEK_API_KEY) {
    return new OpenAI({ apiKey: creds.apiKey, baseURL: baseUrl || undefined, maxRetries: 0 });
  }
  if (!deepseekClient) {
    deepseekClient = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 });
  }
  return deepseekClient;
}

export function getQwenClient(creds?: { apiKey?: string; baseUrl?: string }): OpenAI {
  const envApiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  const apiKey = creds?.apiKey || envApiKey;
  const baseUrl = creds?.baseUrl || process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  if (!apiKey) {
    throw new Error('QWEN_API_KEY (or DASHSCOPE_API_KEY) is not configured');
  }
  // If explicit creds provided and differ from cached, return a fresh client
  if (creds?.apiKey && creds.apiKey !== envApiKey) {
    return new OpenAI({ apiKey: creds.apiKey, baseURL: baseUrl || undefined, maxRetries: 0 });
  }
  if (!qwenClient) {
    qwenClient = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 });
  }
  return qwenClient;
}
