import { getPerplexityService } from "./perplexityService";
import pg from "../db/pg-query";
import logger from "../utils/logger";

interface ConversationData {
  zid: number;
  topic: string;
  description?: string;
  context?: string;
  internal_information?: string;
}

/**
 * Service for managing research dossier generation lifecycle
 */
class ResearchDossierService {
  /**
   * Generate research dossier for a conversation (async background process)
   * @param zid - Conversation ID
   */
  async generateForConversation(zid: number): Promise<void> {
    try {
      logger.info("Starting research dossier generation", { zid });

      // Set status to processing
      await this.updateStatus(zid, "processing", null);

      // Fetch conversation data
      const conversation = await this.getConversationData(zid);

      if (!conversation) {
        throw new Error(`Conversation not found: ${zid}`);
      }

      // Validate required fields
      if (!conversation.topic) {
        throw new Error("Conversation topic is required for research dossier generation");
      }

      if (!conversation.internal_information) {
        logger.warn("No internal information provided, generating with context only", { zid });
      }

      // Generate research dossier using Perplexity
      const perplexityService = getPerplexityService();
      const dossier = await perplexityService.generateResearchDossier({
        topic: conversation.topic,
        description: conversation.description,
        context: conversation.context || "{}",
        internalInformation: conversation.internal_information || "",
      });

      // Save the dossier and mark as completed
      await this.saveDossier(zid, dossier);

      logger.info("Research dossier generated successfully", {
        zid,
        dossierLength: dossier.length,
      });
    } catch (error: any) {
      logger.error("Failed to generate research dossier", {
        zid,
        error: error.message,
        stack: error.stack,
      });

      // Update status to failed with error message
      await this.updateStatus(zid, "failed", error.message);

      // Don't rethrow - this is a background process
    }
  }

  /**
   * Regenerate research dossier (for manual retry)
   * @param zid - Conversation ID
   */
  async regenerateForConversation(zid: number): Promise<void> {
    logger.info("Regenerating research dossier", { zid });
    await this.generateForConversation(zid);
  }

  /**
   * Get conversation data needed for research generation
   */
  private async getConversationData(zid: number): Promise<ConversationData | null> {
    const rows = (await pg.queryP(
      `SELECT zid, topic, description, context, internal_information 
       FROM conversations 
       WHERE zid = $1`,
      [zid]
    )) as any[];

    if (!rows || rows.length === 0) {
      return null;
    }

    return rows[0] as ConversationData;
  }

  /**
   * Update research dossier status
   */
  private async updateStatus(
    zid: number,
    status: "processing" | "completed" | "failed",
    error: string | null
  ): Promise<void> {
    await pg.queryP(
      `UPDATE conversations 
       SET research_dossier_status = $1,
           research_dossier_error = $2
       WHERE zid = $3`,
      [status, error, zid]
    );

    logger.info("Research dossier status updated", { zid, status, hasError: !!error });
  }

  /**
   * Save generated dossier and mark as completed
   */
  private async saveDossier(zid: number, dossier: string): Promise<void> {
    const now = Date.now();
    
    await pg.queryP(
      `UPDATE conversations 
       SET research_dossier = $1,
           research_dossier_status = $2,
           research_dossier_generated_at = $3,
           research_dossier_error = NULL
       WHERE zid = $4`,
      [dossier, "completed", now, zid]
    );

    logger.info("Research dossier saved", { zid, timestamp: now });
  }

  /**
   * Get research dossier for a conversation
   */
  async getDossier(zid: number): Promise<{
    dossier: string | null;
    status: string | null;
    generatedAt: number | null;
    error: string | null;
  }> {
    const rows = (await pg.queryP(
      `SELECT research_dossier, research_dossier_status, 
              research_dossier_generated_at, research_dossier_error
       FROM conversations 
       WHERE zid = $1`,
      [zid]
    )) as any[];

    if (!rows || rows.length === 0) {
      throw new Error(`Conversation not found: ${zid}`);
    }

    const row = rows[0];
    return {
      dossier: row.research_dossier,
      status: row.research_dossier_status,
      generatedAt: row.research_dossier_generated_at,
      error: row.research_dossier_error,
    };
  }
}

// Export singleton instance
let researchDossierServiceInstance: ResearchDossierService | null = null;

export function getResearchDossierService(): ResearchDossierService {
  if (!researchDossierServiceInstance) {
    researchDossierServiceInstance = new ResearchDossierService();
  }
  return researchDossierServiceInstance;
}

export default ResearchDossierService;

