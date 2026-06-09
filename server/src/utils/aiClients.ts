import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';
import { queryP } from '../db/pg-query';

const ENCRYPTION_KEY = process.env.POLIS_INTERNAL_PROXY_SECRET || 'default-key-change-me';
const ALGORITHM = 'aes-256-gcm';

function decryptApiKey(encrypted: string): string {
  try {
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const parts = encrypted.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');
    const [iv, authTag, ciphertext] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Try base64 format (Agora-compatible)
    try {
      const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
      const parts = encrypted.split(':');
      if (parts.length !== 3) throw new Error('Invalid encrypted format');
      const [ivB64, ciphertextB64, authTagB64] = parts;
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
      let decrypted = decipher.update(ciphertextB64, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      // If not encrypted (plain text stored), return as-is
      return encrypted;
    }
  }
}

async function resolvePolisProviderCredentials(provider: string): Promise<{ apiKey: string; baseUrl?: string } | null> {
  try {
    const rows = await queryP(
      'SELECT api_key, base_url FROM polis_provider_api_keys WHERE provider = $1 AND is_active = true',
      [provider.toLowerCase().trim()]
    );
    if (rows.length > 0) {
      return {
        apiKey: decryptApiKey(rows[0].api_key),
        baseUrl: rows[0].base_url || undefined,
      };
    }
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
  if (!creds) throw new Error(`No API key configured for "${provider}"`);

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
