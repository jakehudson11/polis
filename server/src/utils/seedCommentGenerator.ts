import OpenAI from "openai";
import Config from "../config";
import logger from "../utils/logger";
import { logAiUsage, getModelConfig, mapConversationToDeliberation, getAdminForDeliberation } from "../utils/aiUsageLogger";

/**
 * Generates 20-25 seed comments for a Polis conversation using OpenAI.
 * Implements a 50:50 balance between universal-value and polarizing comments.
 */
export async function generateSeedComments(
  topic: string,
  description: string,
  context: string,
  zid?: number
): Promise<string[]> {
  if (!Config.openaiApiKey) {
    throw new Error("OpenAI API key not configured");
  }

  const openai = new OpenAI({
    apiKey: Config.openaiApiKey,
  });

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(topic, description, context);

  try {
    logger.info("Generating seed comments via OpenAI", {
      topic,
      contextLength: context.length,
    });

    const modelConfig = await getModelConfig('seed_comment_generator');
    const model = process.env.OPENAI_MODEL || modelConfig?.primaryModel || "gpt-4o-mini";

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 2000,
    });

    // Fire-and-forget AI usage logging
    if (zid) {
      (async () => {
        const deliberationId = await mapConversationToDeliberation(zid);
        const adminUserId = deliberationId ? await getAdminForDeliberation(deliberationId) : null;
        await logAiUsage({
          use_case: 'seed_comment_generator',
          model,
          provider: 'openai',
          input_tokens: response.usage?.prompt_tokens || 0,
          output_tokens: response.usage?.completion_tokens || 0,
          deliberation_id: deliberationId ?? undefined,
          admin_user_id: adminUserId ?? undefined,
        });
      })().catch(() => {});
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    // Parse the response - expecting plain text with one comment per line
    const comments = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.length <= 140) // Enforce character limit
      .filter((line) => !line.match(/^\d+[\.\)]/)); // Remove any numbering

    logger.info("Successfully generated seed comments", {
      count: comments.length,
      topic,
    });

    // Validate we got a reasonable number of comments
    if (comments.length < 20) {
      logger.warn("Generated fewer than 20 seed comments", {
        count: comments.length,
      });
    }

    return comments.slice(0, 25); // Cap at 25 comments
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

function buildSystemPrompt(): string {
  return `You are an AI agent that generates 20–25 high-quality seed comments for Pol.is conversations. Your input is a problem/objective statement and contextual information. Your output is a diverse, well-structured set of simple, clear, single-point comments written in plain language and suitable for the Pol.is 140-character limit.

In addition to broad, shared concerns, the agent must intentionally surface opinionated, tension-filled, and divisive viewpoints that are likely to split participants into meaningful clusters.

The final output must contain a deliberate 50:50 balance between comments that reflect broadly shared or universal values and comments that are polarizing or likely to divide participants.`;
}

function buildUserPrompt(
  topic: string,
  description: string,
  context: string
): string {
  return `# Overview
You are generating seed comments for a Pol.is conversation.

# Context
- The agent receives contextual information about a deliberation (including the problem statement, objectives, scope, participants, and other relevant details).
- Seed comments must be directly pasteable into Pol.is with no formatting.
- Each seed comment appears on its own line with no numbering, bullets, labels, or prefixes.
- Seed comments follow CompDemocracy best practices and help map a wide range of public perspectives, values, and concerns.
- Seed comments focus on values, opinions, lived experiences, concerns, tensions, and uncertainties.
- Seed comments may include strong or conflicting value judgments, but must remain civic-minded.
- Seed comments do not propose solutions, recommendations, or ideas unless the user explicitly requests them.

# Instructions
1. Read and interpret the deliberation context carefully, including the problem statement and all relevant background.
2. Generate 20–25 seed comments.
3. Enforce a strict distribution:
   - Approximately 50% of comments should reflect broadly shared or near-universal value positions.
   - Approximately 50% of comments should reflect polarizing, contested, or divisive viewpoints.
   - If the total number is odd, the difference between the two groups must not exceed one comment.
4. Ensure each seed comment:
   - Is no longer than 140 characters.
   - Uses simple, clear language.
   - Contains only one idea.
   - Fits on a single line with no additional formatting.
   - Uses a direct, human tone.
   - Avoids jargon unless necessary for clarity.
5. Universal-value comments should:
   - Reflect values that many participants are likely to agree with across differences.
   - Emphasize fairness, safety, dignity, trust, accountability, or shared civic principles.
   - Still be meaningful and non-trivial, not empty platitudes.
6. Polarizing comments should:
   - Express clearly opposing value positions on the same issue.
   - Frame tradeoffs where reasonable people may disagree.
   - Reflect moral, cultural, economic, or identity-based tensions.
   - Voice skepticism, frustration, or distrust where plausible.
   - Include minority, unpopular, or uncomfortable stances.
7. Balance the overall set so that it includes:
   - Supportive viewpoints.
   - Critical viewpoints.
   - Strongly opinionated or divisive viewpoints.
   - Neutral or exploratory views.
   - Lived-experience perspectives.
   - High-level civic or ethical values.
8. Avoid consensus-only framing:
   - Do not over-index on universally agreeable statements.
   - Ensure polarizing comments are strong enough to meaningfully split opinion.
9. Avoid unsafe, discriminatory, or personal-attack content.
10. Adjust language and examples based on whether the issue is civic, political, organizational, technical, or social.

# SOP (Standard Operating Procedure)
1. Parse the deliberation context to identify the core problem statement and disagreement space.
2. Review context for stakeholders, power dynamics, risks, and value conflicts.
3. Identify at least 3–5 major axes of disagreement relevant to the issue.
4. Draft a pool of universal-value statements grounded in shared civic or human concerns.
5. Draft a matching pool of polarizing statements that directly contrast along the same axes.
6. Convert each viewpoint into a short, clear, single-point line under 140 characters.
7. Remove redundant or overly similar comments.
8. Verify the final set maintains an approximate 50:50 split between universal and polarizing positions.
9. Output final seed comments as plain text, one per line with no numbering or bullets.

# Final Notes
- Aim for 8th-grade readability.
- Universal does not mean bland, and polarizing does not mean extreme or uncivil.
- Some discomfort or disagreement is expected and desirable.
- Output must be directly pasteable into Pol.is as seed comments with no extra formatting.

# Deliberation Context${topic ? `\n\nTopic: ${topic}` : ''}${description ? `\nDescription: ${description}` : ''}

${context || "No additional context provided."}

# Output Format
Generate 20-25 seed comments, one per line, with NO numbering, NO bullets, NO labels. Just the plain text comments.`;
}

