import logger from "../../utils/logger";
import { BaseAgent, TranscriptSegment } from "./baseAgent";
import { getPerplexityService } from "../perplexityService";

export class FactCheckerAgent extends BaseAgent {
  constructor() {
    super("fact-checker");
  }

  /**
   * Detect factual claims in transcript segments
   * Looks for statements with numbers, dates, statistics, or claims about reality
   */
  detectFactualClaims(segments: TranscriptSegment[]): Array<{
    segment: TranscriptSegment;
    claim: string;
  }> {
    const claims: Array<{ segment: TranscriptSegment; claim: string }> = [];

    for (const segment of segments) {
      const text = segment.text.trim();
      
      // Skip if too short
      if (text.length < 20) continue;

      // Skip questions
      if (text.endsWith("?") || text.toLowerCase().startsWith("what") || 
          text.toLowerCase().startsWith("how") || text.toLowerCase().startsWith("why")) {
        continue;
      }

      // Skip opinions (common opinion indicators)
      const opinionIndicators = [
        "i think", "i believe", "i feel", "in my opinion", "i would say",
        "seems like", "probably", "maybe", "might", "could be",
      ];
      const lowerText = text.toLowerCase();
      if (opinionIndicators.some(indicator => lowerText.includes(indicator))) {
        continue;
      }

      // Look for factual indicators:
      // - Numbers/statistics
      // - Dates/years
      // - Percentages
      // - Specific claims about facts
      const hasNumber = /\d+/.test(text);
      const hasDate = /\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(text);
      const hasPercentage = /%\s*$|percent|percentage/i.test(text);
      const hasFactualLanguage = /according to|research shows|studies|data|statistics|report|found that|shows that/i.test(text);

      if (hasNumber || hasDate || hasPercentage || hasFactualLanguage) {
        // Extract the claim (sentence containing the fact)
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (trimmed.length > 20 && (hasNumber || hasDate || hasPercentage || hasFactualLanguage)) {
            claims.push({
              segment,
              claim: trimmed,
            });
            break; // One claim per segment
          }
        }
      }
    }

    return claims;
  }

  /**
   * Check if a fact has already been checked
   */
  async hasBeenChecked(meetingId: number, claim: string): Promise<boolean> {
    const state = await this.getAgentState(meetingId);
    if (!state || !state.context) {
      return false;
    }

    const context = typeof state.context === "string" 
      ? JSON.parse(state.context) 
      : state.context;
    
    const checkedFacts = context.checked_facts || [];
    
    // Normalize claim for comparison (lowercase, remove extra spaces)
    const normalizedClaim = claim.toLowerCase().trim().replace(/\s+/g, " ");
    
    return checkedFacts.some((checked: string) => {
      const normalizedChecked = checked.toLowerCase().trim().replace(/\s+/g, " ");
      // Check if claims are similar (same first 50 chars or very similar)
      return normalizedChecked === normalizedClaim ||
             (normalizedClaim.length > 50 && normalizedChecked.substring(0, 50) === normalizedClaim.substring(0, 50));
    });
  }

  /**
   * Add a fact to the checked facts list
   */
  async markAsChecked(meetingId: number, claim: string): Promise<void> {
    const state = await this.getAgentState(meetingId);
    const context = state?.context 
      ? (typeof state.context === "string" ? JSON.parse(state.context) : state.context)
      : {};
    
    const checkedFacts = context.checked_facts || [];
    checkedFacts.push(claim);
    
    // Keep only last 50 checked facts to avoid unbounded growth
    if (checkedFacts.length > 50) {
      checkedFacts.shift();
    }
    
    context.checked_facts = checkedFacts;
    
    await this.updateAgentState(meetingId, {
      context,
    });
  }

  /**
   * Format fact-check result as a chat message
   */
  formatFactCheckMessage(claim: string, result: any): string {
    const sources = result.sources || [];
    const sourceText = sources.length > 0 
      ? `\n\nSources:\n${sources.slice(0, 3).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`
      : "";

    if (!result.isAccurate) {
      return `🔍 Fact Check: "${claim}"\n\nThis claim appears to be inaccurate or needs clarification.\n\n${result.explanation}${sourceText}`;
    } else if (result.needsClarification) {
      return `🔍 Fact Check: "${claim}"\n\nThis claim is partially accurate but needs context:\n\n${result.explanation}${sourceText}`;
    } else {
      // Don't post if fact is accurate and doesn't need clarification
      return "";
    }
  }

  /**
   * Act on a meeting - check facts and post corrections
   */
  async act(meetingId: number): Promise<void> {
    try {
      // Get recent transcripts
      const state = await this.getAgentState(meetingId);
      const lastSegmentId = state?.last_transcript_segment_id;
      const transcripts = await this.getTranscripts(meetingId, lastSegmentId);

      if (transcripts.length === 0) {
        logger.debug("Fact checker agent skipping - no new transcripts", { meetingId });
        return;
      }

      // Detect factual claims
      const claims = this.detectFactualClaims(transcripts);

      if (claims.length === 0) {
        logger.debug("Fact checker agent skipping - no factual claims detected", { meetingId });
        // Update last segment ID even if no claims found
        const lastSegmentIdNew = transcripts.length > 0 
          ? transcripts[transcripts.length - 1].segment_id 
          : lastSegmentId;
        await this.updateAgentState(meetingId, {
          last_transcript_segment_id: lastSegmentIdNew,
        });
        return;
      }

      // Check each claim
      const perplexityService = getPerplexityService();
      let postedCount = 0;

      for (const { segment, claim } of claims) {
        // Skip if already checked
        if (await this.hasBeenChecked(meetingId, claim)) {
          continue;
        }

        try {
          // Fact-check the claim
          const result = await perplexityService.factCheck(claim);

          // Mark as checked
          await this.markAsChecked(meetingId, claim);

          // Only post if fact is inaccurate or needs clarification
          if (!result.isAccurate || result.needsClarification) {
            const message = this.formatFactCheckMessage(claim, result);
            
            if (message) {
              await this.postComment(
                meetingId,
                message,
                true, // raise hand
                "fact-check",
                {
                  claim,
                  isAccurate: result.isAccurate,
                  needsClarification: result.needsClarification,
                  sources: result.sources,
                }
              );
              postedCount++;
            }
          }

          // Rate limiting: don't check more than 3 facts per action
          if (postedCount >= 3) {
            break;
          }

          // Small delay between fact-checks to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error("Error fact-checking claim", {
            error,
            claim: claim.substring(0, 100),
            meetingId,
          });
          // Continue with next claim
        }
      }

      // Update state
      const lastSegmentIdNew = transcripts.length > 0 
        ? transcripts[transcripts.length - 1].segment_id 
        : lastSegmentId;
      const actionCount = (state?.action_count || 0) + postedCount;

      await this.updateAgentState(meetingId, {
        last_action_at: postedCount > 0 ? new Date() : undefined,
        last_transcript_segment_id: lastSegmentIdNew,
        action_count: actionCount,
      });

      if (postedCount > 0) {
        logger.info("Fact checker agent acted", {
          meetingId,
          claimsChecked: claims.length,
          factsPosted: postedCount,
        });
      }
    } catch (error) {
      logger.error("Error in fact checker agent act", {
        error,
        meetingId,
      });
      throw error;
    }
  }
}



