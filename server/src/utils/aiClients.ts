import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GoogleGenAI } from '@google/genai';

async function resolvePolisProviderCredentials(provider: string): Promise<{ apiKey: string; baseUrl?: string } | null> {
  // Environment variables are the authoritative (and only) source of API keys
  // and base URLs for the local LLM stack.
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
  if (!creds) throw new Error(`No API key configured for "${provider}". Set ${provider.toUpperCase()}_API_KEY (or the provider-specific var) in the Polis .env file.`);

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

/**
 * utils/aiGoogleVertex, loaded on FIRST USE rather than at module scope.
 *
 * That module statically imports `@google/genai` and `google-auth-library`, and
 * that require chain (google-auth-library -> gaxios -> node-fetch -> whatwg-url
 * -> tr46) fails outright in installs where tr46 is incomplete. A module-scope
 * import here would therefore take down every existing consumer of this file
 * (aiModelRouter -> routes) even with the Vertex switch OFF. Deferring the
 * require keeps the API-key path's runtime module graph exactly as it was.
 * The `import type` for GoogleGenAI above is erased at emit, so it adds no
 * runtime edge either.
 */
type GoogleVertexModule = typeof import('./aiGoogleVertex');

let googleVertexModule: GoogleVertexModule | null = null;

function getGoogleVertexModule(): GoogleVertexModule {
  if (!googleVertexModule) {
    googleVertexModule = require('./aiGoogleVertex') as GoogleVertexModule;
  }
  return googleVertexModule;
}

/**
 * Env-only half of the Vertex gate, read directly so that "switch off" neither
 * loads utils/aiGoogleVertex nor depends on it. Accepts the same opt-in values as
 * isGoogleVertexEnabled() (`true` / `1` / `yes`), which remains the source of
 * truth for the switch itself.
 */
function isVertexSwitchOn(): boolean {
  const value = process.env.GOOGLE_VERTEX_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * True when the google provider should run on Vertex AI instead of the API-key
 * (AI Studio) path used above: `GOOGLE_VERTEX_ENABLED=true` AND a GCP project
 * can be resolved.
 *
 * Polis defaults the switch to OFF, so the API-key client stays the default and
 * nothing changes until an operator sets the flag.
 */
export function isGeminiVertexMode(): boolean {
  if (!isVertexSwitchOn()) return false;
  return getGoogleVertexModule().isGoogleVertexConfigured();
}

/**
 * `@google/genai` client in Vertex mode (service-account / ADC OAuth).
 *
 * The legacy `@google/generative-ai` client cannot authenticate to
 * aiplatform.googleapis.com at all, so reaching this while the switch is off is
 * a caller bug rather than a case to fall back from -- hence the fail-fast.
 * Delegates to the shared cached client so the Vertex option bag (and the single
 * stub-bridging cast it needs) stays confined to utils/aiGoogleVertex.ts.
 */
export function getGeminiVertexClient(): GoogleGenAI {
  if (!isVertexSwitchOn()) {
    throw new Error(
      'getGeminiVertexClient() called while GOOGLE_VERTEX_ENABLED is not true. Gate the call on ' +
      'isGeminiVertexMode(), or use getGeminiClient() for the API-key path.'
    );
  }
  return getGoogleVertexModule().getGoogleGenAIClient();
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
