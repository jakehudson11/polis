import axios, { AxiosError } from "axios";
import Config from "../config";
import logger from "../utils/logger";

interface PerplexityMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface PerplexityResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  citations?: string[]; // URLs of sources used
}

interface FactCheckResult {
  isAccurate: boolean;
  explanation: string;
  sources: string[];
  needsClarification: boolean;
}

interface ResearchDossierParams {
  topic: string;
  description?: string;
  context: string;
  internalInformation: string;
  jurisdiction?: string;
}

class PerplexityService {
  private apiKey: string;
  private baseUrl: string = "https://api.perplexity.ai";

  constructor() {
    if (!Config.perplexityApiKey) {
      throw new Error("PERPLEXITY_API_KEY is not configured");
    }
    this.apiKey = Config.perplexityApiKey;
  }

  /**
   * Fact-check a claim using Perplexity API
   * @param claim - The factual claim to verify
   * @returns Fact-check result with accuracy, explanation, and sources
   */
  async factCheck(claim: string): Promise<FactCheckResult> {
    try {
      const messages: PerplexityMessage[] = [
        {
          role: "system",
          content: `You are a fact-checking assistant. Analyze the given claim and determine if it is accurate, inaccurate, or needs clarification. 
Provide sources for your assessment. Format your response as JSON with:
- "isAccurate": boolean (true if claim is accurate, false if inaccurate)
- "explanation": string (brief explanation of the fact-check)
- "sources": string[] (array of source URLs or citations)
- "needsClarification": boolean (true if claim is partially true or needs context)

Be concise and factual.`,
        },
        {
          role: "user",
          content: `Fact-check this claim: "${claim}"`,
        },
      ];

      const response = await axios.post<PerplexityResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          model: "llama-3.1-sonar-large-128k-online",
          messages,
          temperature: 0.2,
          max_tokens: 500,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const content = response.data.choices[0]?.message?.content || "";
      
      // Try to parse JSON from response
      let result: FactCheckResult;
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        result = JSON.parse(jsonStr);
      } catch (parseError) {
        // If JSON parsing fails, extract information from text
        logger.warn("Failed to parse Perplexity JSON response, extracting from text", { content });
        result = this.extractFactCheckFromText(content, claim);
      }

      logger.info("Fact-check completed", {
        claim: claim.substring(0, 100),
        isAccurate: result.isAccurate,
        sourcesCount: result.sources?.length || 0,
      });

      return result;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Perplexity API error", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
        error: axiosError.message,
      });
      throw new Error(
        `Perplexity API error: ${axiosError.response?.status} - ${
          (axiosError.response?.data as any)?.error?.message || axiosError.message
        }`
      );
    }
  }

  /**
   * Extract fact-check result from text response when JSON parsing fails
   */
  private extractFactCheckFromText(text: string, claim: string): FactCheckResult {
    const lowerText = text.toLowerCase();
    
    // Determine accuracy from keywords
    const isAccurate = 
      lowerText.includes("accurate") && !lowerText.includes("inaccurate") ||
      lowerText.includes("correct") && !lowerText.includes("incorrect") ||
      lowerText.includes("true") && !lowerText.includes("false");

    const needsClarification = 
      lowerText.includes("partially") ||
      lowerText.includes("clarification") ||
      lowerText.includes("context");

    // Extract URLs as sources
    const urlRegex = /https?:\/\/[^\s\)]+/g;
    const sources = text.match(urlRegex) || [];

    return {
      isAccurate: isAccurate || false,
      explanation: text.substring(0, 500), // First 500 chars
      sources,
      needsClarification,
    };
  }

  /**
   * Generate a comprehensive research dossier using Perplexity Deep Research
   * @param params - Research parameters including topic, context, and internal information
   * @returns Comprehensive research dossier in markdown format
   */
  async generateResearchDossier(params: ResearchDossierParams): Promise<string> {
    try {
      const { topic, description, context, internalInformation, jurisdiction } = params;

      // Parse context to extract participant information
      let parsedContext: any = {};
      try {
        parsedContext = typeof context === 'string' ? JSON.parse(context) : context;
      } catch (e) {
        logger.warn("Failed to parse context JSON", { error: e });
      }

      // Build the system prompt
      const systemPrompt = this.buildResearchDossierSystemPrompt();

      // Build the user prompt with all contextual information
      const userPrompt = this.buildResearchDossierUserPrompt({
        topic,
        description,
        parsedContext,
        internalInformation,
        jurisdiction,
      });

      logger.info("Generating research dossier", {
        topic: topic?.substring(0, 100),
        contextLength: context?.length || 0,
        internalInfoLength: internalInformation?.length || 0,
      });

      const messages: PerplexityMessage[] = [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ];

      const response = await axios.post<PerplexityResponse>(
        `${this.baseUrl}/chat/completions`,
        {
          model: "sonar-deep-research", // Dedicated deep research model
          messages,
          temperature: 0.2, // Lower temperature for more focused, comprehensive research
          max_tokens: 16000, // Increased for more comprehensive output
          search_recency_filter: "month", // Focus on recent, relevant information
          return_citations: true,
          return_images: false,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 600000, // 10 minutes timeout for deep research (these can take longer)
        }
      );

      let dossier = response.data.choices[0]?.message?.content || "";

      // Strip out AI thinking process tags (e.g., <think>...</think>)
      dossier = this.stripThinkingTags(dossier);

      // Append sources/citations if available
      if (response.data.citations && response.data.citations.length > 0) {
        dossier += "\n\n---\n\n## Sources\n\n";
        dossier += "The following sources were consulted in preparing this research dossier:\n\n";
        response.data.citations.forEach((citation, index) => {
          dossier += `${index + 1}. ${citation}\n`;
        });
      }

      logger.info("Research dossier generated successfully", {
        topic: topic?.substring(0, 100),
        dossierLength: dossier.length,
        tokensUsed: response.data.usage?.total_tokens || 0,
        citationsCount: response.data.citations?.length || 0,
      });

      return dossier;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error("Perplexity Deep Research API error", {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
        error: axiosError.message,
      });
      throw new Error(
        `Perplexity Deep Research API error: ${axiosError.response?.status} - ${
          (axiosError.response?.data as any)?.error?.message || axiosError.message
        }`
      );
    }
  }

  /**
   * Strip thinking process tags from the response
   */
  private stripThinkingTags(content: string): string {
    // Remove <think>...</think> tags and their content
    let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
    
    // Remove any standalone <think> or </think> tags
    cleaned = cleaned.replace(/<\/?think>/gi, '');
    
    // Clean up any extra whitespace left behind
    cleaned = cleaned.replace(/^\s+/gm, '').replace(/\n{3,}/g, '\n\n');
    
    return cleaned.trim();
  }

  /**
   * Build the system prompt for the research dossier agent
   */
  private buildResearchDossierSystemPrompt(): string {
    return `# Overview
You are a Deep Research Agent operating within a deliberative democracy platform. Your role is to produce a comprehensive, exhaustive, and highly impartial research dossier that informs participants before and during an ongoing deliberative process. Think of yourself as conducting expert-level research that would normally take days or weeks—you must be thorough, nuanced, and deeply informative.

Your output must educate participants with ALL necessary background knowledge to engage meaningfully in deliberation. Surface the strongest evidence-based perspectives, provide deep historical and contextual understanding, explain complex concepts clearly, and clearly distinguish between established facts, areas of uncertainty, and contested interpretations. The report must enable informed deliberation without advocating for any position.

**CRITICAL REQUIREMENT**: This dossier should be COMPREHENSIVE enough that participants with little to no prior knowledge can become well-informed on the topic. Do not create a brief summary—create a thorough educational resource.

---

## Context
You will be provided with:
- A deliberation topic or policy question selected by an administrator.
- Contextual information about the deliberative process and its goals.
- Details about participants, including demographics, expertise levels, and civic roles.
- Internal, non-public information supplied by administrators that cannot be found via external research.

Guidance:
- Use the internal admin-provided information as complementary context.
- Do not treat internal information as automatically authoritative unless explicitly stated.
- Tailor explanations, depth, and language to participant knowledge levels inferred from context.
- If participant knowledge level is unclear, assume low prior knowledge and explain foundational concepts clearly and thoroughly.
- Include sufficient depth that someone could genuinely understand the nuances of the issue.

---

## Instructions for Deep Research

### Phase 1: Foundation Building
1. **Clearly restate and frame the deliberation question** - what exactly is being discussed and why does it matter?
2. **Define ALL key terms, concepts, and jargon** necessary for understanding. Assume participants may not know these.
3. **Provide extensive historical context** - what led to this situation? What are the key historical events, decisions, and turning points?
4. **Map the current landscape** - what is the present state of affairs? What are recent developments?

### Phase 2: Deep Contextual Analysis
5. **Explore multiple dimensions thoroughly**:
   - **Historical dimension**: Deep dive into relevant history, tracing developments over time
   - **Legal/Regulatory dimension**: What laws, regulations, or governance structures are relevant?
   - **Economic dimension**: What are the economic factors, costs, benefits, trade-offs?
   - **Social/Cultural dimension**: What cultural, social, or demographic factors matter?
   - **Political dimension**: What are the political dynamics, power structures, and stakeholder positions?
   - **Scientific/Technical dimension** (if relevant): What does the evidence say? What are the technical considerations?
   - **Ethical/Philosophical dimension**: What are the underlying values and ethical questions?

### Phase 3: Comprehensive Research Integration
6. **Conduct exhaustive external research** using the highest-quality sources, prioritizing:
   - Peer-reviewed academic literature and scholarly research
   - Official government reports, white papers, and policy documents
   - Intergovernmental organizations (UN, WHO, World Bank, etc.)
   - Leading research institutions, universities, and think tanks
   - Reputable data agencies and statistical sources
   - High-standard NGOs and policy institutes
   - Credible journalism from major publications
   - Expert analyses and commissioned reports

7. **Integrate internal admin-provided information** where relevant, clearly distinguishing it from externally sourced material.

### Phase 4: Comprehensive Viewpoint Mapping
8. **Present ALL major evidence-based viewpoints comprehensively**, including:
   - **Areas of broad expert consensus** - what do most experts agree on?
   - **Mainstream perspectives** - what are the major schools of thought?
   - **Legitimate disagreements** - where do experts disagree and why? What evidence supports each side?
   - **Emerging perspectives** - what new thinking or research is developing?
   - **Minority positions** - what alternative views exist that have scholarly or evidence-based support?
   - **Historical evolution of thought** - how have perspectives changed over time?

9. **Explain the reasoning behind different positions** - don't just state what people think, explain WHY they think it, what evidence they rely on, and what values or assumptions underlie their positions.

### Phase 5: Evidence Quality & Limitations
10. **Avoid all normative, persuasive, or emotive language** - remain strictly neutral and analytical.

11. **Explicitly and thoroughly identify**:
   - What is well-established and broadly accepted
   - What is uncertain, debated, or contested (and why)
   - What evidence is missing, limited, or of varying quality
   - What assumptions different perspectives make
   - What trade-offs exist between different outcomes

12. **Ensure rigorous sourcing**: Every factual claim, statistic, empirical assertion, or data point must be sourced and verifiable with inline citations.

### Phase 6: Structure & Presentation
13. **Create a comprehensive, well-structured dossier** that participants can reference repeatedly during deliberation. Organize the information in the way that makes most logical sense for this specific topic.

14. **Write for clarity and accessibility** while maintaining accuracy and depth. Use examples, analogies, and clear explanations when dealing with complex concepts.

---

## Output Format

Structure your response as a comprehensive markdown document organized in the way that best serves the content and topic. **AIM FOR MAXIMUM DEPTH AND LENGTH** - this should be a substantial educational resource, not a brief summary.

### Organizational Freedom:
- Choose the headings, sections, and structure that best fit this specific topic
- Organize information logically based on how the research naturally unfolds
- Create whatever subsections and hierarchies make sense for the content
- Let the evidence and research guide the structure

### Content Expectations (organize as you see fit):
- Include a substantial overview/summary section
- Provide comprehensive background, context, and definitions
- Cover all relevant dimensions (historical, economic, social, legal, political, scientific, ethical, etc.)
- Present multiple perspectives with detailed explanations
- Address key debates, areas of consensus, and points of uncertainty
- Include thorough sourcing throughout

### Formatting Guidelines:
- Use proper markdown: headers (##, ###, ####), lists, blockquotes for important notes
- Include inline citations throughout [Source Name, Year]
- Use tables or structured lists where appropriate
- Bold key concepts on first use
- Use blockquotes to highlight particularly important findings or quotes
- Let the content dictate the best formatting approach

---

## Final Notes: Maximizing Comprehensiveness

**YOUR PRIMARY GOAL IS COMPREHENSIVENESS**: 
- This is NOT a brief overview - it should be an in-depth educational resource
- Assume participants know little about the topic
- Provide sufficient depth that someone could genuinely engage in informed deliberation
- Do not sacrifice important nuance or context for brevity
- Include sufficient examples, case studies, and concrete illustrations
- Aim for the depth and breadth of a university-level literature review or policy briefing

**Quality Standards**:
- The goal is to inform comprehensively, not to persuade
- Do not simplify at the expense of accuracy or important nuance
- Do not introduce speculation beyond what sources support
- Maintain absolute transparency about evidence quality and limitations
- Assume your output will directly determine the quality of democratic deliberation

**Remember**: A well-informed citizenry is the foundation of effective democracy. Your research dossier is a critical tool for enabling meaningful, informed deliberation.`;
  }

  /**
   * Build the user prompt with all contextual information
   */
  private buildResearchDossierUserPrompt(params: {
    topic: string;
    description?: string;
    parsedContext: any;
    internalInformation: string;
    jurisdiction?: string;
  }): string {
    const { topic, description, parsedContext, internalInformation, jurisdiction } = params;

    let prompt = `Please generate a comprehensive research dossier for the following deliberation:\n\n`;
    
    prompt += `**Topic:** ${topic}\n\n`;
    
    if (description) {
      prompt += `**Description:** ${description}\n\n`;
    }

    if (jurisdiction) {
      prompt += `**Jurisdiction:** ${jurisdiction}\n\n`;
    }

    // Add context from questionnaire
    if (parsedContext && Object.keys(parsedContext).length > 0) {
      prompt += `**Deliberation Context (from questionnaire):**\n\n`;
      
      // Define the standard questions
      const standardQuestions: Record<string, string> = {
        '1': 'What is the problem or objective you want to address with this deliberation?',
        '2': 'Why are you conducting this deliberation exercise? What would you like to achieve?',
        '3': 'What is it about this issue that is so important right now?',
        '4': 'What is within and out of scope for this deliberation?',
        '5': 'What area/sector/field does your organisation operate in? Give us a summary of what you do and don\'t do as an organisation',
        '6': 'Tell us more about the participants who will be undertaking the deliberation. How much do they know about the deliberation topic?',
        '7': 'Is there sensitive or potentially harmful context that needs careful framing? Are there assumptions or non-negotiables that we should be aware of?',
        '8': 'Is there anything else that you think is important to share?',
      };
      
      // Handle answers object format
      if (parsedContext.answers) {
        const answers = parsedContext.answers;
        Object.keys(answers).sort().forEach((key) => {
          const answer = answers[key];
          if (answer && answer.trim()) {
            const question = standardQuestions[key] || `Question ${key}`;
            prompt += `**Q${key}: ${question}**\n${answer}\n\n`;
          }
        });
      }
      // Fallback to old format if questions array exists
      else if (parsedContext.questions) {
        const contextQuestions = parsedContext.questions || [];
        contextQuestions.forEach((q: any) => {
          if (q.answer) {
            prompt += `**Q: ${q.question}**\n${q.answer}\n\n`;
          }
        });
      }
    }

    // Add internal information
    if (internalInformation) {
      prompt += `**Internal Information (provided by administrator):**\n\n`;
      prompt += `${internalInformation}\n\n`;
    }

    prompt += `---\n\n## Your Task

Please conduct a deep, comprehensive research investigation and generate an extensive, impartial research dossier that will serve as the primary educational resource for participants.

**Research Scope**: This should be exhaustive and thorough - conduct multi-step research across:
- Academic and scholarly sources
- Government and policy documents
- Research institutions and think tanks
- Expert analyses and data
- Historical archives and records
- Recent news and developments

**Coverage Requirements**: Ensure the dossier covers:
- Complete historical context and background
- All relevant dimensions (political, economic, social, cultural, legal, ethical, scientific)
- Multiple perspectives with detailed explanations of reasoning
- Current state of affairs with recent data
- Key debates and points of contention
- Areas of consensus and disagreement among experts
- Uncertainties and knowledge gaps

**Depth & Comprehensiveness**: This is NOT a summary - create a substantial educational resource that:
- Assumes participants have little prior knowledge
- Explains complex concepts clearly with examples
- Provides sufficient depth for meaningful deliberation
- Includes extensive sourcing and citations
- Is detailed enough to serve as a reference throughout the deliberation process

Your goal is to enable truly informed democratic deliberation by providing ALL the background knowledge participants need.`;

    return prompt;
  }
}

// Export singleton instance
let perplexityServiceInstance: PerplexityService | null = null;

export function getPerplexityService(): PerplexityService {
  if (!perplexityServiceInstance) {
    perplexityServiceInstance = new PerplexityService();
  }
  return perplexityServiceInstance;
}

export default PerplexityService;



