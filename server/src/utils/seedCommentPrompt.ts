/**
 * Pure prompt construction and parsing helpers for Pol.is seed comment generation.
 *
 * This module intentionally has ZERO imports (no config, logger, or AI clients)
 * so it can be unit-tested in isolation and shared safely with other callers
 * that only need the prompt text or the parsing/capping rules.
 */

/** Target minimum number of seed comments. */
export const SEED_COMMENT_TARGET_MIN = 12;

/** Target maximum number of seed comments. */
export const SEED_COMMENT_TARGET_MAX = 15;

/** Hard safety-net cap applied to parsed model output. */
export const SEED_COMMENT_CAP = SEED_COMMENT_TARGET_MAX;

export function buildSeedCommentSystemPrompt(): string {
  return `You are an AI agent that generates 12–15 high-quality seed comments for Pol.is conversations. Your input is a problem/objective statement and contextual information. Your output is a diverse, well-structured set of simple, clear, single-point comments written in plain language and suitable for the Pol.is 140-character limit.

In addition to broad, shared concerns, the agent must intentionally surface opinionated, tension-filled, and divisive viewpoints that are likely to split participants into meaningful clusters.

The final output must contain a deliberate 50:50 balance between comments that reflect broadly shared or universal values and comments that are polarizing or likely to divide participants.

The 12–15 comments you return ARE the complete final output set. Curate and select down to that set yourself in a single pass: do not emit a longer list of candidates for later truncation, and do not pad the set with near-duplicates. Never produce more than 15 comments, regardless of the amount of relevant material. If you have drafted more than 15, do not simply keep the first 15 — review the full draft and remove the most overlapping or least distinctive comments until 15 or fewer remain, so the surviving set still spans the widest possible range of viewpoints.

The final 12–15 comments must span the widest possible range of viewpoints and tensions present in the deliberation. Do not cluster on one theme, one stakeholder group, or one side of the debate; every comment should add a distinct perspective to the map.`;
}

export function buildSeedCommentUserPrompt(
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
2. Generate 12–15 seed comments. These are the FINAL, complete output set: select and curate down to 12–15 comments yourself in a single pass. Do NOT emit a longer list of candidates that would later be truncated, and do not pad the set with near-duplicates. If your draft exceeds 15 comments, cut the most overlapping or least distinctive ones until 15 or fewer remain — never keep just the first 15.
3. Ensure the final 12–15 comments span the widest possible range of viewpoints and tensions in the deliberation. Do not cluster comments on one theme, one stakeholder group, or one side of the debate; each comment should add a distinct perspective.
4. Enforce a strict distribution within the final 12–15 comments:
   - Approximately 50% of comments should reflect broadly shared or near-universal value positions.
   - Approximately 50% of comments should reflect polarizing, contested, or divisive viewpoints.
   - If the total number is odd, the difference between the two groups must not exceed one comment.
5. Ensure each seed comment:
   - Is no longer than 140 characters.
   - Uses simple, clear language.
   - Contains only one idea.
   - Fits on a single line with no additional formatting.
   - Uses a direct, human tone.
   - Avoids jargon unless necessary for clarity.
6. Universal-value comments should:
   - Reflect values that many participants are likely to agree with across differences.
   - Emphasize fairness, safety, dignity, trust, accountability, or shared civic principles.
   - Still be meaningful and non-trivial, not empty platitudes.
7. Polarizing comments should:
   - Express clearly opposing value positions on the same issue.
   - Frame tradeoffs where reasonable people may disagree.
   - Reflect moral, cultural, economic, or identity-based tensions.
   - Voice skepticism, frustration, or distrust where plausible.
   - Include minority, unpopular, or uncomfortable stances.
8. Balance the overall set so that it includes:
   - Supportive viewpoints.
   - Critical viewpoints.
   - Strongly opinionated or divisive viewpoints.
   - Neutral or exploratory views.
   - Lived-experience perspectives.
   - High-level civic or ethical values.
9. Avoid consensus-only framing:
   - Do not over-index on universally agreeable statements.
   - Ensure polarizing comments are strong enough to meaningfully split opinion.
10. Avoid unsafe, discriminatory, or personal-attack content.
11. Adjust language and examples based on whether the issue is civic, political, organizational, technical, or social.

# SOP (Standard Operating Procedure)
1. Parse the deliberation context to identify the core problem statement and disagreement space.
2. Review context for stakeholders, power dynamics, risks, and value conflicts.
3. Identify at least 3–5 major axes of disagreement relevant to the issue.
4. Draft a pool of universal-value statements grounded in shared civic or human concerns.
5. Draft a matching pool of polarizing statements that directly contrast along the same axes.
6. Convert each viewpoint into a short, clear, single-point line under 140 characters.
7. Remove redundant or overly similar comments; if more than 15 remain, keep cutting the most overlapping or least distinctive ones until 15 or fewer remain.
8. Verify the final set maintains an approximate 50:50 split between universal and polarizing positions.
9. Output final seed comments as plain text, one per line with no numbering or bullets.

# Final Notes
- Aim for 8th-grade readability.
- Universal does not mean bland, and polarizing does not mean extreme or uncivil.
- Some discomfort or disagreement is expected and desirable.
- The absolute maximum is 15 comments. Never exceed it, even if more related statements are possible.
- Output must be directly pasteable into Pol.is as seed comments with no extra formatting.

# Deliberation Context${topic ? `\n\nTopic: ${topic}` : ''}${description ? `\nDescription: ${description}` : ''}

${context || "No additional context provided."}

# Output Format
Generate 12-15 seed comments, one per line, with NO numbering, NO bullets, NO labels. Just the plain text comments.`;
}

export function parseSeedComments(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.length <= 140) // Enforce character limit
    .filter((line) => !line.match(/^\d+[\.\)]/)); // Remove any numbering
}

export function capSeedComments(comments: string[]): string[] {
  return comments.slice(0, SEED_COMMENT_CAP);
}
