import logger from "../../utils/logger";
import pgQuery from "../../db/pg-query";
import { ModeratorAgent } from "./moderatorAgent";
import { FactCheckerAgent } from "./factCheckerAgent";
import { SpeakingTimeMonitorAgent } from "./speakingTimeMonitorAgent";

const WORKER_CHECK_INTERVAL_MS = 60000; // Check every minute
const WORKER_STARTUP_DELAY_MS = 30000; // Wait 30 seconds after server startup

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

/**
 * Get active meetings that should have agents running
 */
async function getActiveMeetings(): Promise<Array<{ meeting_id: number }>> {
  const query = `
    SELECT meeting_id
    FROM meetings
    WHERE bot_status IN ('joined', 'in_call', 'recording')
      AND actual_start IS NOT NULL
      AND actual_end IS NULL
    ORDER BY meeting_id
  `;

  const result = await pgQuery.queryP(query, []) as any[];
  return result.map((row) => ({ meeting_id: row.meeting_id }));
}

/**
 * Run all agents for a single meeting
 */
async function runAgentsForMeeting(meetingId: number): Promise<void> {
  try {
    const moderatorAgent = new ModeratorAgent();
    const factCheckerAgent = new FactCheckerAgent();
    const speakingTimeMonitorAgent = new SpeakingTimeMonitorAgent();

    // Run agents in parallel (they handle their own timing checks)
    await Promise.allSettled([
      moderatorAgent.act(meetingId).catch((error) => {
        logger.error("Moderator agent error", { error, meetingId });
      }),
      factCheckerAgent.act(meetingId).catch((error) => {
        logger.error("Fact checker agent error", { error, meetingId });
      }),
      speakingTimeMonitorAgent.act(meetingId).catch((error) => {
        logger.error("Speaking time monitor agent error", { error, meetingId });
      }),
    ]);
  } catch (error) {
    logger.error("Error running agents for meeting", {
      error,
      meetingId,
    });
    // Don't throw - continue with other meetings
  }
}

/**
 * Main worker loop
 */
async function runAgentWorker(): Promise<void> {
  if (workerRunning) {
    logger.warn("Agent worker already running");
    return;
  }

  workerRunning = true;
  logger.info("Starting meeting agent worker");

  try {
    while (workerRunning) {
      try {
        const activeMeetings = await getActiveMeetings();

        if (activeMeetings.length > 0) {
          logger.debug(`Processing ${activeMeetings.length} active meetings`);

          // Process meetings in parallel (with concurrency limit)
          const concurrencyLimit = 5;
          for (let i = 0; i < activeMeetings.length; i += concurrencyLimit) {
            const batch = activeMeetings.slice(i, i + concurrencyLimit);
            await Promise.all(
              batch.map((meeting) => runAgentsForMeeting(meeting.meeting_id))
            );
          }
        } else {
          logger.debug("No active meetings found");
        }
      } catch (error) {
        logger.error("Error in agent worker loop", error);
        // Continue running even if one iteration fails
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, WORKER_CHECK_INTERVAL_MS));
    }
  } catch (error) {
    logger.error("Fatal error in agent worker", error);
    workerRunning = false;
    throw error;
  }
}

/**
 * Start the agent worker
 */
export function startAgentWorker(): void {
  if (workerInterval) {
    logger.warn("Agent worker already started");
    return;
  }

  // Wait a bit after server startup before starting worker
  setTimeout(() => {
    runAgentWorker().catch((error) => {
      logger.error("Agent worker crashed", error);
      // Restart after delay
      setTimeout(() => {
        logger.info("Restarting agent worker after crash");
        startAgentWorker();
      }, 60000);
    });
  }, WORKER_STARTUP_DELAY_MS);

  logger.info("Agent worker scheduled to start");
}

/**
 * Stop the agent worker
 */
export function stopAgentWorker(): void {
  workerRunning = false;
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  logger.info("Agent worker stopped");
}

/**
 * Check if worker is running
 */
export function isWorkerRunning(): boolean {
  return workerRunning;
}



