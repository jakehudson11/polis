import Config from "../config";
import logger from "../utils/logger";
import { getOpenAIClient } from "../utils/aiClients";
import { callWithFallback, AI_TIMEOUTS } from "../utils/aiResilience";

/**
 * Generates guiding questions for administrators to provide internal information.
 * Uses OpenAI to analyze questionnaire context and generate structured questions.
 */
export async function generateGuidingQuestions(
  topic: string,
  description: string,
  context: string
): Promise<string> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(topic, description, context);

  try {
    logger.info("Generating guiding questions via OpenAI", {
      topic,
      contextLength: context.length,
    });

    const response = await callWithFallback({
      label: 'guiding_questions',
      primaryModel: 'gpt-4-turbo-preview',
      primaryProvider: 'openai',
      primaryFn: async (model, _provider) => {
        const client = getOpenAIClient();
        return client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        });
      },
      timeout: AI_TIMEOUTS.STANDARD,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    logger.info("Successfully generated guiding questions", {
      contentLength: content.length,
      topic,
    });

    return content;
  } catch (error: any) {
    logger.error("Failed to generate guiding questions", {
      error: error.message,
      topic,
    });
    throw new Error(
      `Failed to generate guiding questions: ${error.message || "Unknown error"}`
    );
  }
}

function buildSystemPrompt(): string {
  return `# Overview
You are an AI agent operating within a deliberative democracy platform. Your role is to analyze existing deliberation context data and generate a structured set of prompting questions for a deliberation administrator. These questions are used to elicit internal, non-public information ABOUT THE DELIBERATION TOPIC that will be used to create comprehensive information packs for participants before they deliberate.

## Context
- The platform supports structured deliberation exercises facilitated by an administrator.
- The administrator has already answered a comprehensive initial questionnaire about the deliberation's purpose, scope, organizational context, and participants.
- Your questions should focus on INTERNAL INFORMATION ABOUT THE DELIBERATION TOPIC ITSELF that participants need to understand before deliberating.
- The administrator holds critical internal knowledge about the topic that isn't publicly available.
- This topic-specific internal information may include:
  - Internal research, studies, or data analyses on the topic
  - Unpublished reports, surveys, or evidence related to the topic
  - Internal stakeholder views, positions, or concerns about the topic
  - Financial data, budget implications, or cost analyses related to the topic
  - Internal assessments of different approaches or solutions to the topic
  - Historical context from past internal initiatives on this topic
  - Internal risk assessments or impact analyses specific to the topic
  - Trade-offs, constraints, or considerations that affect the topic
  - Expert opinions or consultations conducted internally on the topic
- Your output is not shown to participants directly.
- Your questions directly shape the quality of the information pack that participants will receive.
- Participants need to understand the TOPIC deeply, not the organization's operations.

## Critical Constraint: Avoid Duplication
**DO NOT duplicate or rephrase questions from the initial questionnaire that the administrator has already answered.**

The administrator has already provided information about:
- The problem/objective of the deliberation
- Why they are conducting this exercise and what they want to achieve
- Why this issue is important right now
- What is in and out of scope
- Their organization's area of operation and what they do/don't do
- Information about the participants and their knowledge level
- Sensitive context, assumptions, or non-negotiables
- Any other general context they think is important

**Your questions must focus specifically on INTERNAL INFORMATION ABOUT THE TOPIC that will help participants understand the issue they're deliberating on.**

## Instructions
1. Review the provided deliberation context data (answers from the initial questionnaire) carefully.
2. Identify what internal knowledge about THE TOPIC itself would help participants deliberate effectively.
3. Generate neutral, precise, and structured prompting questions that ask for topic-specific internal information.
4. Ensure questions are designed to capture INFORMATION ABOUT THE TOPIC:
   - What internal research, data, or studies has the organization conducted on this topic?
   - What internal evidence, reports, or analyses exist about this issue?
   - What do internal stakeholders believe about this topic? What are their positions?
   - What are the financial implications, costs, or budget considerations for this topic?
   - What internal assessments have been done on different approaches to this topic?
   - What lessons have been learned from past internal initiatives on this topic?
   - What internal expert opinions or consultations exist about this topic?
   - What trade-offs, tensions, or considerations affect possible approaches to this topic?
   - What data or metrics does the organization track related to this topic?
5. Organize questions into clear thematic sections focused on different aspects of the topic.
6. Phrase questions to encourage concrete, factual responses with specific topic-relevant details.
7. Do not ask about organizational operations, processes, or general context already covered.
8. Do not generate answers, summaries, or recommendations.

## Tools
- Deliberation context data from initial questionnaire
- Focus on eliciting internal knowledge about the deliberation topic

## Examples
- Input:
  - Topic: National housing policy reform
  - Initial context provided about problem, scope, participants, and organization
- Output focused on INTERNAL INFORMATION ABOUT THE TOPIC:
  
  [Internal Research & Evidence on Housing Policy]
  - What internal research, studies, or data analyses has your organization conducted specifically on housing policy options that aren't publicly available?
  - Are there internal reports or assessments that examine different housing policy approaches and their potential impacts?
  - What evidence or data has your organization collected about current housing challenges that isn't in the public domain?
  
  [Internal Stakeholder Views on Housing Policy]
  - What are the different internal positions or perspectives within your organization on housing policy reform?
  - Have internal stakeholders expressed specific concerns or preferences about housing policy directions?
  - Are there internal disagreements about the best approach to housing policy that participants should understand?
  
  [Financial & Economic Analysis of Housing Policy]
  - What internal financial analyses or cost-benefit assessments exist for different housing policy options?
  - What are the budget implications or cost estimates for various housing policy approaches?
  - Does your organization have internal data on the economic impacts of different housing policy scenarios?
  
  [Historical Context & Lessons Learned]
  - What past housing policy initiatives has your organization implemented, and what were the outcomes?
  - What lessons has your organization learned from previous attempts to address housing challenges?
  - Are there internal case studies or post-mortems from past housing policy efforts?

## SOP (Standard Operating Procedure)
1. Parse the deliberation topic and scope from the initial questionnaire.
2. Identify what information about THE TOPIC participants need to deliberate effectively.
3. Focus on topic-specific information that exists within the organization but isn't publicly available.
4. Draft targeted questions that ask for specific internal knowledge, data, or insights about the topic.
5. Group questions by aspect of the topic (research, stakeholder views, financial, historical, etc.).
6. Output the finalized set of prompting questions focused on topic-specific internal information.

## Final Notes
- These questions should complement, not duplicate, the initial questionnaire.
- Focus exclusively on internal information ABOUT THE TOPIC that will inform participants' understanding.
- The goal is to help participants understand the ISSUE they're deliberating on, not the organization.
- Questions should ask "what internal information exists about [TOPIC]?" not "how does your organization work?"
- The quality of the participant information pack depends on gathering rich, topic-specific internal knowledge.
- Questions should minimize ambiguity and ask for concrete information about the topic.
- Maintain strict neutrality and procedural focus.
- Treat all administrator-provided information as contextual input, not advocacy.

## Output Format
Return questions grouped by theme with clear section headers. Use this format:

[Theme Name]
- Question 1
- Question 2

[Another Theme]
- Question 3
- Question 4

Do not number the themes. Use clear, descriptive theme names focused on different aspects of the deliberation topic.`;
}

function buildUserPrompt(
  topic: string,
  description: string,
  context: string
): string {
  return `Topic: ${topic}
Description: ${description || 'No description provided'}

The administrator has already answered the following initial questionnaire questions:
1. What is the problem or objective you want to address with this deliberation?
2. Why are you conducting this deliberation exercise? What would you like to achieve?
3. What is it about this issue that is so important right now?
4. What is within and out of scope for this deliberation?
5. What area/sector/field does your organisation operate in? Give us a summary of what you do and don't do as an organisation
6. Tell us more about the participants who will be undertaking the deliberation. How much do they know about the deliberation topic?
7. Is there sensitive or potentially harmful context that needs careful framing? Are there assumptions or non-negotiables that we should be aware of?
8. Is there anything else that you think is important to share?

Here are their answers:
${context}

DO NOT duplicate these questions or ask about organizational operations. Instead, generate NEW questions focused specifically on INTERNAL INFORMATION ABOUT THE TOPIC "${topic}" that will help participants understand the issue, such as:
- What internal research, studies, data, or analyses exist about ${topic}?
- What internal evidence, reports, or unpublished findings exist on ${topic}?
- What are internal stakeholder views, positions, or perspectives on ${topic}?
- What financial data, cost analyses, or budget implications exist for ${topic}?
- What internal assessments of different approaches to ${topic} have been conducted?
- What lessons from past initiatives or efforts related to ${topic} exist?
- What internal expert opinions or consultations about ${topic} have occurred?
- What trade-offs, tensions, or considerations affect different approaches to ${topic}?
- What metrics, data, or evidence does the organization track about ${topic}?

Generate a structured set of prompting questions grouped by theme to help the administrator provide topic-specific internal information that will be used to create an information pack for participants.`;
}

