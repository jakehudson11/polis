import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
