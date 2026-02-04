import pg from "../db/pg-query";
import logger from "./logger";
import { getConversationInfo } from "../conversation";

const MAX_CONTEXT_LENGTH = 10000; // Increased from 2000 to handle detailed responses

interface ConversationContext {
  answers?: { [key: string]: string };
  submitted?: boolean;
  version?: number;
  timestamp?: string;
}

// Map of question IDs to their full text (from frontend ConversationQuestionnaire component)
const QUESTION_MAP: { [key: string]: string } = {
  '1': 'What is the problem or objective you want to address with this deliberation?',
  '2': 'Why are you conducting this deliberation exercise? What would you like to achieve?',
  '3': 'What is it about this issue that is so important right now?',
  '4': 'What is within and out of scope for this deliberation?',
  '5': 'What area/sector/field does your organisation operate in? Give us a summary of what you do and don\'t do as an organisation',
  '6': 'Tell us more about the participants who will be undertaking the deliberation',
  '7': 'Is there sensitive or potentially harmful context that needs careful framing? Are there assumptions or non-negotiables that we should be aware of?',
  '8': 'Is there anything else that you think is important to share?',
};

/**
 * Build context from the conversation's context field (which contains questionnaire answers as JSON)
 * OR from the participant_metadata tables if they exist.
 */
export async function buildContextFromQuestionnaire(zid: number): Promise<string> {
  try {
    // First, try to get context from the conversations table
    const conversation = await getConversationInfo(zid);
    
    if (conversation && conversation.context) {
      try {
        // If context is a string, parse it as JSON
        const contextData: ConversationContext = typeof conversation.context === 'string' 
          ? JSON.parse(conversation.context) 
          : conversation.context;
        
        if (contextData.answers) {
          // Format the answers into a readable context string WITH FULL QUESTION TEXT
          const answerParts: string[] = [];
          for (const [questionId, answer] of Object.entries(contextData.answers)) {
            if (answer && answer.trim()) {
              const questionText = QUESTION_MAP[questionId] || `Question ${questionId}`;
              answerParts.push(`${questionText}\n${answer}`);
            }
          }
          
          if (answerParts.length > 0) {
            let fullContext = answerParts.join('\n\n');
            
            // Truncate if too long (but log a warning since this shouldn't happen often)
            if (fullContext.length > MAX_CONTEXT_LENGTH) {
              logger.warn(`Context for zid ${zid} truncated from ${fullContext.length} to ${MAX_CONTEXT_LENGTH} characters.`);
              fullContext = fullContext.substring(0, MAX_CONTEXT_LENGTH) + '... [truncated]';
            }
            
            logger.info(`Built context from questionnaire for zid ${zid}: ${answerParts.length} questions answered, ${fullContext.length} characters`);
            return fullContext;
          }
        }
      } catch (parseError) {
        logger.warn(`Failed to parse context JSON for zid ${zid}:`, parseError);
      }
    }

    // Fallback: try to build from participant_metadata tables (if they exist)
    interface Question {
      pmqid: number;
      key: string;
    }

    interface Answer {
      pmaid: number;
      value: string;
    }

    interface ResponseCount {
      count: number;
    }

    const questions: Question[] = await pg.queryP(
      `SELECT pmqid, key FROM participant_metadata_questions WHERE zid = $1 AND alive = TRUE;`,
      [zid]
    ) as Question[];

    if (!questions || questions.length === 0) {
      logger.info(`No context found for zid ${zid} - questionnaire not yet submitted`);
      return ""; // No questions, no context
    }

    let contextParts: string[] = [];

    for (const question of questions) {
      const pmqid = question.pmqid;
      const questionKey = question.key;

      // Fetch answers for each question
      const answers: Answer[] = await pg.queryP(
        `SELECT pmaid, value FROM participant_metadata_answers WHERE pmqid = $1 AND zid = $2 AND alive = TRUE;`,
        [pmqid, zid]
      ) as Answer[];

      let answerDetails: string[] = [];
      if (answers && answers.length > 0) {
        for (const answer of answers) {
          // Fetch count of participants who chose this answer
          const responseCountResult: ResponseCount[] = await pg.queryP(
            `SELECT COUNT(DISTINCT pid) as count FROM participant_metadata_choices WHERE pmaid = $1 AND zid = $2 AND pmqid = $3 AND alive = TRUE;`,
            [answer.pmaid, zid, pmqid]
          ) as ResponseCount[];
          const count = responseCountResult[0]?.count || 0;
          answerDetails.push(`${answer.value} (${count})`);
        }
      }

      let questionContext = `Question: ${questionKey}`;
      if (answers && answers.length > 0) {
        questionContext += ` | Options: ${answers.map(a => a.value).join(", ")}`;
      }
      if (answerDetails.length > 0) {
        questionContext += ` | Responses: ${answerDetails.join(", ")}`;
      }
      contextParts.push(questionContext);
    }

    let fullContext = contextParts.join(";\n");

    // Truncate if too long
    if (fullContext.length > MAX_CONTEXT_LENGTH) {
      logger.warn(`Context for zid ${zid} truncated from ${fullContext.length} to ${MAX_CONTEXT_LENGTH} characters.`);
      fullContext = fullContext.substring(0, MAX_CONTEXT_LENGTH) + '... [truncated]';
    }

    return fullContext;
  } catch (error) {
    logger.error(`Error building context from questionnaire for zid ${zid}:`, error);
    throw new Error("Failed to build context from questionnaire.");
  }
}

export async function updateConversationContext(zid: number, context: string): Promise<void> {
  try {
    // Don't overwrite the JSON context - it's already there from the frontend
    // This function is kept for compatibility but doesn't need to do anything
    logger.info(`Context for conversation ${zid} already exists in database.`);
  } catch (error) {
    logger.error(`Error updating conversation context for zid ${zid}:`, error);
    throw new Error("Failed to update conversation context.");
  }
}

export async function buildAndUpdateContext(zid: number): Promise<string> {
  const context = await buildContextFromQuestionnaire(zid);
  if (context) {
    await updateConversationContext(zid, context);
  }
  return context;
}
