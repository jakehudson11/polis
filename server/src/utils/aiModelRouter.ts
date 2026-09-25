import { createClientForProvider, getGeminiVertexClient, isGeminiVertexMode } from './aiClients';

export interface NormalizedAIResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIRouterOptions {
  maxTokens?: number;
  temperature?: number;
}

/** HTTP-level timeout for provider API calls (ms).  120 s is generous
 *  enough for the largest LLM responses while avoiding indefinite hangs. */
const PROVIDER_HTTP_TIMEOUT_MS = 120_000;

/** Helper: returns a promise that rejects after `ms` with a descriptive error. */
function createTimeoutRejection(provider: string, ms: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `AI provider HTTP timeout: ${provider} call exceeded ${ms / 1000}s`
      );
      (err as any).code = 'PROVIDER_HTTP_TIMEOUT';
      reject(err);
    }, ms);
    if (timer.unref) timer.unref();
  });
}

/**
 * Clamps temperature for providers that only accept specific values.
 * Moonshot (Kimi) models require temperature = 1.0 exactly.
 */
function clampTemperatureForProvider(provider: string, model: string, temperature: number): number {
  const isMoonshotProvider = provider.trim().toLowerCase() === 'moonshot';
  const isKimiModel = model.toLowerCase().includes('kimi');
  if (isMoonshotProvider || isKimiModel) {
    return 1.0;
  }
  return temperature;
}

/**
 * Google Vertex AI branch for the google provider: the same request/response
 * contract as the API-key branch, issued through @google/genai in Vertex mode.
 * Callers must have checked isGeminiVertexMode() first.
 *
 * Deliberately mirrors the legacy branch: identical system+user prompt
 * flattening, no generation config (the legacy branch forwarded none, so the
 * model defaults still apply), identical response / usageMetadata extraction.
 */
async function callGoogleVertex(
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
): Promise<NormalizedAIResponse> {
  const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';
  const userMsgs = messages.filter(m => m.role !== 'system');
  const prompt = [systemMsg, ...userMsgs.map(m => m.content)].filter(Boolean).join('\n\n');

  // `config` is empty on purpose: GenerateContentConfig is FLAT in @google/genai
  // (no nested generationConfig), and the API-key branch passed no request
  // params, so the Vertex path keeps the model defaults rather than silently
  // introducing a maxOutputTokens cap the legacy path never had.
  const result = await Promise.race([
    getGeminiVertexClient().models.generateContent({ model, contents: prompt, config: {} }),
    createTimeoutRejection('google', PROVIDER_HTTP_TIMEOUT_MS),
  ]);

  return {
    content: result.text,
    inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

export async function callAIProvider(
  model: string,
  provider: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: AIRouterOptions = {}
): Promise<NormalizedAIResponse> {
  const rawTemperature = options.temperature ?? 0.5;
  const temperature = clampTemperatureForProvider(provider, model, rawTemperature);
  const { maxTokens = 1024 } = options;

  // Vertex opt-in gate. When GOOGLE_VERTEX_ENABLED is true and a GCP project
  // resolves, the google provider runs on @google/genai with service-account
  // OAuth and never needs GOOGLE_GEMINI_API_KEY. With the switch off (the Polis
  // default) this is false and control falls straight through to the untouched
  // API-key path below, including its createClientForProvider() credential check.
  if (provider === 'google' && isGeminiVertexMode()) {
    return callGoogleVertex(model, messages);
  }

  const client = await createClientForProvider(provider);

  if (provider === 'google') {
    const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';
    const userMsgs = messages.filter(m => m.role !== 'system');
    const prompt = [systemMsg, ...userMsgs.map(m => m.content)].filter(Boolean).join('\n\n');
    const geminiModel = (client as any).getGenerativeModel({ model });
    const result = await Promise.race([
      geminiModel.generateContent(prompt),
      createTimeoutRejection(provider, PROVIDER_HTTP_TIMEOUT_MS),
    ]);
    return {
      content: result.response.text(),
      inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  if (provider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const anthropic = client as any;
    const response = await Promise.race([
      anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(systemMsg ? { system: systemMsg } : {}),
        messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      }),
      createTimeoutRejection(provider, PROVIDER_HTTP_TIMEOUT_MS),
    ]);
    return {
      content: response.content[0]?.type === 'text' ? response.content[0].text : '',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }

  // OpenAI-compatible (openai, deepseek, qwen, and unknown providers)
  const openaiClient = client as any;
  const completion = await Promise.race([
    openaiClient.chat.completions.create({
      model,
      messages: messages as any,
      max_completion_tokens: maxTokens,
      temperature,
    }),
    createTimeoutRejection(provider, PROVIDER_HTTP_TIMEOUT_MS),
  ]);
  return {
    content: completion.choices[0]?.message?.content ?? '',
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}
