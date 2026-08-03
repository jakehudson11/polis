import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import logger from "../../utils/logger";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";
import { mapConversationToDeliberation, getModelConfig } from "../../utils/aiUsageLogger";
import pg from "../../db/pg-query";

// Initialize DynamoDB client
const dynamoDbConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

// If dynamoDbEndpoint is set, we're running locally (e.g., with Docker)
if (Config.dynamoDbEndpoint) {
  dynamoDbConfig.endpoint = Config.dynamoDbEndpoint;
  // Use dummy credentials for local DynamoDB
  dynamoDbConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  // Use real credentials from environment
  dynamoDbConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}
// If neither are set, the SDK will use default credential provider chain

const dynamoDbClient = new DynamoDB(dynamoDbConfig);

// Create DocumentClient
const docClient = DynamoDBDocument.from(dynamoDbClient);

// Handler for POST /api/v3/delphi/jobs - Create a new Delphi job
export async function handle_POST_delphi_jobs(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.p.delphiEnabled) {
      throw new Error("Unauthorized");
    }
    logger.info(
      `Creating Delphi job with parameters: ${JSON.stringify(req.body)}`
    );

    // Extract parameters from request body
    const {
      report_id,
      conversation_id,
      job_type = "FULL_PIPELINE",
      priority = 50,
      max_votes,
      batch_size,
      // model resolved below with use-case-config priority
      model: explicitModel,
      include_topics = true,
      include_moderation = false, // ignore comments that recieve a failing moderation score
    } = req.body;

    // Resolve model: explicit API param > DB use-case config > env var > hardcoded fallback
    let model: string;
    let backupModel: string | null = null;
    let fallbackModel: string | null = null;
    let primaryProvider: string | null = null;
    let backupProvider: string | null = null;
    let fallbackProvider: string | null = null;
    const DEFAULT_MODEL = "claude-sonnet-4-20250514";

    if (explicitModel) {
      model = explicitModel;
      logger.info(`Using explicitly provided model: ${model}`);
    } else {
      try {
        const config = await getModelConfig('delphi_report');
        if (config?.primaryModel) {
          model = config.primaryModel;
          backupModel = config.backupModel ?? null;
          fallbackModel = config.fallbackModel ?? null;
          primaryProvider = config.primaryProvider ?? null;
          backupProvider = config.backupProvider ?? null;
          fallbackProvider = config.fallbackProvider ?? null;
          logger.info(`Using model from polis_ai_use_case_config: ${model}` +
            (backupModel ? ` (backup: ${backupModel})` : '') +
            (fallbackModel ? ` (fallback: ${fallbackModel})` : ''));
        } else {
          model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
          logger.info(`No delphi_report use-case config found, using env/default: ${model}`);
        }
      } catch (err: any) {
        model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
        logger.warn(`Failed to read delphi_report use-case config: ${err.message}, falling back to: ${model}`);
      }
    }

    // Validate required parameters
    if (!report_id && !conversation_id) {
      res.status(400).json({
        status: "error",
        error:
          "Missing required parameter: either report_id or conversation_id must be provided",
      });
      return;
    }

    // Convert report_id to conversation_id if needed
    // Assuming there's a mapping function or service to do this
    const zid =
      conversation_id ||
      (report_id ? await getConversationIdFromReportId(report_id) : null);

    if (!zid) {
      res.status(400).json({
        status: "error",
        error: "Could not determine conversation ID",
      });
      return;
    }

    // Resolve deliberation_id from Agora for cross-system tracking
    let deliberationId: string | null = null;
    try {
      deliberationId = await mapConversationToDeliberation(parseInt(String(zid), 10));
    } catch (mapErr: any) {
      logger.warn(`Could not resolve deliberation_id for zid=${zid}: ${mapErr.message}`);
    }

    // --- Deduplication: check for existing PENDING/PROCESSING jobs for the same report_id ---
    if (report_id) {
      try {
        const existingJobParams = {
          TableName: "Delphi_JobQueue",
          FilterExpression:
            "report_id = :rid AND (#s = :pending OR #s = :processing)",
          ExpressionAttributeNames: {
            "#s": "status",
          },
          ExpressionAttributeValues: {
            ":rid": report_id,
            ":pending": "PENDING",
            ":processing": "PROCESSING",
          },
        };
        const existingResult = await docClient.scan(existingJobParams);
        if (existingResult.Items && existingResult.Items.length > 0) {
          const existingJob = existingResult.Items[0];
          logger.info(
            `Dedup: returning existing ${existingJob.status} job ${existingJob.job_id} for report_id ${report_id}`
          );
          res.json({
            status: "success",
            message: `Existing ${existingJob.status} job found for this conversation`,
            job_id: existingJob.job_id,
            deliberation_id: deliberationId || null,
            existing: true,
            job_status: existingJob.status,
          });
          return;
        }
      } catch (dedupErr: any) {
        logger.warn(
          `Dedup check failed, proceeding with new job: ${dedupErr.message}`
        );
      }
    }

    // Generate a unique job ID
    const job_id = uuidv4();

    // Current timestamp in ISO format
    const now = new Date().toISOString();

    // Build job configuration based on the Python CLI implementation
    const jobConfig: any = {};

    if (job_type === "FULL_PIPELINE") {
      // Full pipeline configs
      const stages = [];

      // PCA stage
      const pcaConfig: any = {};
      if (max_votes) {
        pcaConfig.max_votes = parseInt(max_votes, 10);
      }
      if (batch_size) {
        pcaConfig.batch_size = parseInt(batch_size, 10);
      }
      stages.push({ stage: "PCA", config: pcaConfig });

      // UMAP stage
      stages.push({
        stage: "UMAP",
        config: {
          n_neighbors: 15,
          min_dist: 0.1,
        },
      });

      // Report stage
      stages.push({
        stage: "REPORT",
        config: {
          model: model,
          provider: primaryProvider,
          backup_model: backupModel,
          backup_provider: backupProvider,
          fallback_model: fallbackModel,
          fallback_provider: fallbackProvider,
          include_topics: include_topics,
        },
      });

      // Add stages and visualizations to job config
      jobConfig.stages = stages;
      jobConfig.visualizations = ["basic", "enhanced", "multilayer"];
    }

    jobConfig.include_moderation = include_moderation;
    // Create job item with version number for optimistic locking
    const jobItem = {
      job_id: job_id, // Primary key
      status: "PENDING", // Secondary index key
      created_at: now, // Secondary index key
      updated_at: now,
      version: 1, // Version for optimistic locking
      started_at: "", // Using empty strings for nullable fields
      completed_at: "",
      worker_id: "none", // Non-empty placeholder for index
      job_type: job_type,
      priority: parseInt(String(priority), 10),
      conversation_id: String(zid), // Using conversation_id
      deliberation_id: deliberationId || "", // Resolved from Agora for cross-system tracking
      report_id: report_id, // Include report_id for proper S3 paths
      retry_count: 1,
      max_retries: 3,
      timeout_seconds: 14400, // 4 hours default timeout
      job_config: JSON.stringify(jobConfig),
      job_results: JSON.stringify({}),
      logs: JSON.stringify({
        entries: [
          {
            timestamp: now,
            level: "INFO",
            message: `Job created for conversation ${zid}`,
          },
        ],
        log_location: "",
      }),
      created_by: "api",
    };

    // Put item in DynamoDB
    try {
      logger.info(
        `Putting job item in DynamoDB: ${JSON.stringify({
          TableName: "Delphi_JobQueue",
          Item: {
            job_id: jobItem.job_id,
            conversation_id: jobItem.conversation_id,
          },
        })}`
      );

      await docClient.put({
        TableName: "Delphi_JobQueue",
        Item: jobItem,
      });

      // Return success with job ID
      res.json({
        status: "success",
        job_id: job_id,
        deliberation_id: deliberationId || null,
      });
    } catch (dbError) {
      logger.error(
        `Error writing to DynamoDB: ${
          dbError instanceof Error ? dbError.message : dbError
        }`
      );
      throw dbError; // Let the outer catch handle it
    }
  } catch (error) {
    logger.error(
      `Error creating Delphi job: ${
        error instanceof Error ? error.message : error
      }`
    );
    // Log more details for better debugging
    if (error instanceof Error) {
      logger.error(`Error name: ${error.name}`);
      logger.error(`Error stack: ${error.stack}`);
    }

    // Return detailed error for debugging
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
      code:
        error instanceof Error && "code" in error
          ? (error as any).code
          : undefined,
      details: Config.nodeEnv === "development" ? String(error) : undefined,
    });
  }
}

// Helper function to get conversation_id from report_id
async function getConversationIdFromReportId(
  report_id: string
): Promise<string | null> {
  try {
    logger.info(`Getting conversation_id for report_id: ${report_id}`);

    // Use the existing util function if available, otherwise implement here
    if (typeof getZidFromReport === "function") {
      const zid = await getZidFromReport(report_id);
      // Ensure we return a string or null to match the function signature
      return zid !== null ? zid.toString() : null;
    }

    // Strip the 'r' prefix if it exists (e.g., r123abc -> 123abc)
    let normalized_report_id = report_id;
    if (report_id.startsWith("r") && report_id.length > 1) {
      normalized_report_id = report_id.substring(1);
    }

    // In this case, we need to query the zid from the zinvites table
    // The report_id is the same as the zinvite
    const query = `
      SELECT zid 
      FROM zinvites 
      WHERE zinvite = $1
    `;

    // Connect to PostgreSQL using the imported query function
    const rows = (await pg.queryP(query, [normalized_report_id])) as {
      zid: string;
    }[];

    if (rows.length === 0) {
      logger.error(`No conversation found for report_id: ${report_id}`);
      return null;
    }

    const zid = rows[0].zid;
    logger.info(`Found conversation_id ${zid} for report_id: ${report_id}`);

    return zid.toString();
  } catch (error) {
    logger.error(
      `Error mapping report_id to conversation_id: ${
        error instanceof Error ? error.message : error
      }`
    );
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
    return null;
  }
}

// Handler for GET /api/v3/delphi/jobs - List Delphi jobs
export async function handle_GET_delphi_jobs(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!req.p?.delphiEnabled) {
      res.status(403).json({ status: "error", error: "Unauthorized" });
      return;
    }
    const { status, limit = "50", conversation_id } = req.query;
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const filterParts: string[] = [];
    const expressionValues: Record<string, any> = {};
    const expressionNames: Record<string, string> = {};
    if (status && status !== "all") {
      const statusStr = status as string;
      if (statusStr.includes(',')) {
        // Comma-separated: use IN operator with array of values
        const statuses = statusStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        // DynamoDB IN requires individual placeholders: :status0, :status1, etc.
        const inClauses: string[] = [];
        for (let i = 0; i < statuses.length; i++) {
          const key = `:status${i}`;
          inClauses.push(key);
          expressionValues[key] = statuses[i];
        }
        filterParts.push(`#s IN (${inClauses.join(', ')})`);
        expressionNames["#s"] = "status";
      } else {
        // Single value: use = operator (existing behavior)
        filterParts.push("#s = :status");
        expressionNames["#s"] = "status";
        expressionValues[":status"] = statusStr;
      }
    }
    if (conversation_id) {
      filterParts.push("conversation_id = :zid");
      expressionValues[":zid"] = conversation_id;
    }
    const params: any = { TableName: "Delphi_JobQueue", Limit: parsedLimit };
    if (filterParts.length > 0) {
      params.FilterExpression = filterParts.join(" AND ");
      params.ExpressionAttributeValues = expressionValues;
      if (Object.keys(expressionNames).length > 0) {
        params.ExpressionAttributeNames = expressionNames;
      }
    }
    const result = await docClient.scan(params);
    const jobs = (result.Items || []).map((item: any) => ({
      jobId: item.job_id,
      status: item.status,
      jobType: item.job_type,
      priority: item.priority,
      conversationId: item.conversation_id,
      deliberationId: item.deliberation_id || null,
      reportId: item.report_id || null,
      retryCount: item.retry_count || 0,
      maxRetries: item.max_retries || 3,
      createdAt: item.created_at,
      startedAt: item.started_at || null,
      completedAt: item.completed_at || null,
      workerId: item.worker_id || null,
      error: item.error || (() => {
        try {
          if (item.job_results) {
            const parsed = typeof item.job_results === 'string' ? JSON.parse(item.job_results) : item.job_results;
            return parsed?.error || null;
          }
        } catch {}
        return null;
      })(),
      jobConfig: item.job_config || null,
      progressPercent: item.progress_percent ?? null,
      progressMessage: item.progress_message ?? null,
    }));
    res.json({ status: "success", jobs, total: result.Count || jobs.length });
  } catch (err: any) {
    logger.error("Error fetching Delphi jobs:", err);
    res.status(500).json({ status: "error", error: err.message || "Internal server error" });
  }
}

// Handler for GET /api/v3/delphi/jobs/:jobId - Get a single Delphi job by ID
export async function handle_GET_delphi_job(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const jobId = req.params.jobId;
    if (!jobId) {
      res.status(400).json({ status: "error", error: "Missing required parameter: jobId" });
      return;
    }

    const params = {
      TableName: "Delphi_JobQueue",
      Key: { job_id: jobId },
    };
    const result = await docClient.get(params);
    const item = result.Item;

    if (!item) {
      res.status(404).json({ status: "error", error: "Job not found" });
      return;
    }

    const error = item.error || (() => {
      try {
        if (item.job_results) {
          const parsed = typeof item.job_results === 'string' ? JSON.parse(item.job_results) : item.job_results;
          return parsed?.error || null;
        }
      } catch {}
      return null;
    })();

    const job = {
      jobId: item.job_id,
      status: item.status,
      jobType: item.job_type,
      priority: item.priority,
      conversationId: item.conversation_id,
      deliberationId: item.deliberation_id || null,
      reportId: item.report_id || null,
      retryCount: item.retry_count || 0,
      maxRetries: item.max_retries || 3,
      createdAt: item.created_at,
      startedAt: item.started_at || null,
      completedAt: item.completed_at || null,
      workerId: item.worker_id || null,
      error,
      jobConfig: item.job_config || null,
      progressPercent: item.progress_percent ?? null,
      progressMessage: item.progress_message ?? null,
    };

    res.json({ status: "success", job });
  } catch (err: any) {
    logger.error("Error fetching Delphi job:", err);
    res.status(500).json({ status: "error", error: err.message || "Internal server error" });
  }
}

// Handler for GET /api/v3/delphi/queue-stats - Get queue statistics
export async function handle_GET_delphi_queue_stats(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const result = await docClient.scan({
      TableName: "Delphi_JobQueue",
      ProjectionExpression: "#s",
      ExpressionAttributeNames: { "#s": "status" },
    });
    const stats: Record<string, number> = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
    for (const item of result.Items || []) {
      const s = item.status;
      if (s in stats) stats[s]++;
    }
    res.json({ status: "success", backend: "dynamodb", stats });
  } catch (err: any) {
    logger.error("Error fetching Delphi queue stats:", err);
    res.status(500).json({ status: "error", error: err.message || "Internal server error" });
  }
}
