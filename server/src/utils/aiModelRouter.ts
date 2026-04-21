import { getOpenAIClient, getAnthropicClient, getGeminiClient } from './aiClients';

export interface NormalizedAIResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIRouterOptions {
  maxTokens?: number;
  temperature?: number;
}

export async function callAIProvider(
  model: string,
  provider: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options: AIRouterOptions = {}
): Promise<NormalizedAIResponse> {
  const { maxTokens = 1024, temperature = 0.5 } = options;

  if (provider === 'google') {
    const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';
    const userMsgs = messages.filter(m => m.role !== 'system');
    const prompt = [systemMsg, ...userMsgs.map(m => m.content)].filter(Boolean).join('\n\n');
    const geminiModel = getGeminiClient().getGenerativeModel({ model });
    const result = await geminiModel.generateContent(prompt);
    return {
      content: result.response.text(),
      inputTokens: result.response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  if (provider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemMsg ? { system: systemMsg } : {}),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    });
    return {
      content: response.content[0]?.type === 'text' ? response.content[0].text : '',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }

  // OpenAI (default)
  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model,
    messages: messages as any,
    max_completion_tokens: maxTokens,
    temperature,
  });
  return {
    content: completion.choices[0]?.message?.content ?? '',
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}
