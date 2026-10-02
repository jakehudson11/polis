import Config from "../config";
import logger from "../utils/logger";
import { logAiUsage, getModelConfig, mapConversationToDeliberation, getAdminForDeliberation } from "../utils/aiUsageLogger";
import { callWithFallback, AI_TIMEOUTS } from "../utils/aiResilience";
import { AI_PRIORITY } from "../utils/aiProviderQueues";
import { callAIProvider } from "./aiModelRouter";
import {
  SEED_COMMENT_CAP,
  SEED_COMMENT_TARGET_MIN,
  buildSeedCommentSystemPrompt,
  buildSeedCommentUserPrompt,
  parseSeedComments,
  capSeedComments,
} from "./seedCommentPrompt";

/**
 * Generates up to 15 seed comments (targeting 12-15) for a Pol.is conversation using OpenAI.
 * Implements a 50:50 balance between universal-value and polarizing comments.
 */
export async function generateSeedComments(
  topic: string,
  description: string,
  context: string,
  zid?: number
): Promise<string[]> {
  const systemPrompt = buildSeedCommentSystemPrompt();
  const userPrompt = buildSeedCommentUserPrompt(topic, description, context);

  try {
    logger.info("Generating seed comments via OpenAI", {
      topic,
      contextLength: context.length,
    });

    const modelConfig = await getModelConfig('seed_comment_generator');
    const model = process.env.OPENAI_MODEL || modelConfig?.primaryModel || "gpt-4o-mini";
    const primaryProvider = modelConfig?.primaryProvider ?? 'openai';

    // Resolve deliberation metadata up front so it can be shared by the
    // Agora proxy (budget enforcement) and local usage logging.
    const deliberationId = zid ? await mapConversationToDeliberation(zid) : null;
    const adminUserId = deliberationId ? await getAdminForDeliberation(deliberationId) : null;

    const { result, usedModel, usedProvider, usedTier, proxied } = await callWithFallback({
      label: 'seed_comments',
      primaryModel: model,
      primaryProvider,
      backupModel: modelConfig?.backupModel ?? undefined,
      backupProvider: modelConfig?.backupProvider ?? undefined,
      fallbackModel: modelConfig?.fallbackModel ?? undefined,
      fallbackProvider: modelConfig?.fallbackProvider ?? undefined,
      primaryFn: async (model, provider) => {
        return callAIProvider(model, provider, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], { maxTokens: 2000, temperature: 0.8 });
      },
      backupFn: async (model, provider) => {
        return callAIProvider(model, provider, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], { maxTokens: 2000, temperature: 0.8 });
      },
      timeout: AI_TIMEOUTS.STANDARD,
      priority: AI_PRIORITY.BACKGROUND,
      useAgoraProxy: true,
      agoraProxy: {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 2000,
        temperature: 0.8,
        useCase: 'seed_comment_generator',
        deliberationId: deliberationId ?? undefined,
        adminUserId: adminUserId ?? undefined,
      },
    });

    // Fire-and-forget AI usage logging — Agora already logged usage for
    // proxied results, so skip our own log to avoid double-logging.
    if (zid && proxied !== true) {
      (async () => {
        await logAiUsage({
          use_case: 'seed_comment_generator',
          model: usedModel,
          provider: usedProvider,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          deliberation_id: deliberationId ?? undefined,
          admin_user_id: adminUserId ?? undefined,
          origin: 'polis',
        });
      })().catch(() => {});
    }

    // callWithFallback may deliver the raw content string (Agora proxy path)
    // or a NormalizedAIResponse object (local provider chain) — accept both.
    const content = typeof result === 'string' ? result : result.content;
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    // Parse the response - expecting plain text with one comment per line
    const parsed = parseSeedComments(content);

    // Safety net: the prompt demands a curated 12-15 comment set, so any
    // over-production here is unexpected and must be observable in logs.
    let comments = parsed;
    if (parsed.length > SEED_COMMENT_CAP) {
      logger.warn("Seed generation over-produced; truncating to cap", {
        rawCount: parsed.length,
        cap: SEED_COMMENT_CAP,
      });
      comments = capSeedComments(parsed);
    }

    logger.info("Successfully generated seed comments", {
      count: comments.length,
      topic,
    });

    // Validate we got a reasonable number of comments
    if (comments.length < SEED_COMMENT_TARGET_MIN) {
      logger.warn(`Generated fewer than ${SEED_COMMENT_TARGET_MIN} seed comments`, {
        count: comments.length,
      });
    }

    return comments;
  } catch (error: any) {
    logger.error("Failed to generate seed comments", {
      error: error.message,
      topic,
    });
    throw new Error(
      `Failed to generate seed comments: ${error.message || "Unknown error"}`
    );
  }
}

