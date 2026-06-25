import { Request, Response } from "express";
import logger from "../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { getZidFromReport } from "../utils/parameter";
import Config from "../config";

const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
} else if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
  dynamoDBConfig.credentials = {
    accessKeyId: Config.AWS_ACCESS_KEY_ID,
    secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
  };
}

const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

const logsClient = new CloudWatchLogsClient({
  region: Config.AWS_REGION || "us-east-1",
});

/**
 * Handler for Delphi API route that retrieves LLM topic names from DynamoDB
 */
export async function handle_GET_delphi(req: Request, res: Response) {
  logger.info("Delphi API request received");

  const report_id = req.query.report_id as string;
  if (!report_id) {
    return res.status(400).json({
      status: "error",
      message: "report_id is required",
    });
  }

  try {
    const zid = await getZidFromReport(report_id);
    if (!zid) {
      return res.status(404).json({
        status: "error",
        message: "Could not find conversation for report_id",
        report_id: report_id,
      });
    }

    const conversation_id = zid.toString();
    const tableName = "Delphi_CommentClustersLLMTopicNames";

    logger.info(
      `Fetching Delphi LLM topics for conversation_id: ${conversation_id}`
    );

    // Also fetch current job UUID from narrative reports for correct section key construction
    let currentJobUuid = null;
    try {
      const narrativeReportsTable = "Delphi_NarrativeReports";
      const gsiName = "ReportIdTimestampIndex";

      const narrativeParams: any = {
        TableName: narrativeReportsTable,
        IndexName: gsiName,
        KeyConditionExpression: "report_id = :rid",
        ExpressionAttributeValues: { ":rid": report_id },
        Limit: 1, // Just need one to get the job UUID pattern
      };

      const narrativeResult = await docClient.send(
        new QueryCommand(narrativeParams)
      );
      if (narrativeResult.Items && narrativeResult.Items.length > 0) {
        const sampleSection = narrativeResult.Items[0].section;
        // Extract job UUID from section name if it contains UUID pattern
        if (
          sampleSection &&
          sampleSection.includes("-") &&
          sampleSection.includes("_")
        ) {
          const uuidMatch = sampleSection.match(
            /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/
          );
          if (uuidMatch) {
            currentJobUuid = uuidMatch[1];
            logger.info(`Found current job UUID: ${currentJobUuid}`);
          }
        }
      }
    } catch (err) {
      logger.warn(`Could not fetch job UUID from narrative reports: ${err}`);
    }

    const allItems: any[] = [];
    let lastEvaluatedKey;

    do {
      const params: any = {
        TableName: tableName,
        KeyConditionExpression: "conversation_id = :cid",
        ExpressionAttributeValues: { ":cid": conversation_id },
        ExclusiveStartKey: lastEvaluatedKey,
      };

      const data = await docClient.send(new QueryCommand(params));
      if (data.Items) {
        allItems.push(...data.Items);
      }
      lastEvaluatedKey = data.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (allItems.length === 0) {
      return res.json({
        status: "success",
        message: "No LLM topics found for this conversation",
        report_id,
        runs: {}, // Return "runs" object for consistency
      });
    }

    const runGroups: Record<string, any[]> = {};
    allItems.forEach((item) => {
      const modelName = item.model_name || "unknown";
      const createdAt = item.created_at || "";
      const createdDate = createdAt.substring(0, 10);
      const runKey = `${modelName}_${createdDate}`;
      if (!runGroups[runKey]) {
        runGroups[runKey] = [];
      }
      runGroups[runKey].push(item);
    });

    const allRuns: Record<string, any> = {};
    Object.entries(runGroups).forEach(([runKey, runItems]) => {
      const topicsByLayer: Record<string, Record<string, any>> = {};
      runItems.forEach((item) => {
        const layerId = item.layer_id;
        const clusterId = item.cluster_id;
        if (!topicsByLayer[layerId]) {
          topicsByLayer[layerId] = {};
        }
        topicsByLayer[layerId][clusterId] = {
          topic_name: item.topic_name,
          model_name: item.model_name,
          created_at: item.created_at,
          topic_key: item.topic_key,
        };
      });
      const sampleItem = runItems[0];
      allRuns[runKey] = {
        model_name: sampleItem.model_name,
        created_date: sampleItem.created_at,
        topics_by_layer: topicsByLayer,
        item_count: runItems.length,
        job_uuid: currentJobUuid, // Include job UUID for section key construction
      };
    });

    const sortedRuns = Object.entries(allRuns)
      .sort(([, runA], [, runB]) => {
        const dateA = new Date(runA.created_date || 0);
        const dateB = new Date(runB.created_date || 0);
        return dateB.getTime() - dateA.getTime();
      })
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {} as Record<string, any>);

    return res.json({
      status: "success",
      message: "LLM topics retrieved successfully",
      report_id,
      runs: sortedRuns,
    });
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") {
      logger.warn(
        `DynamoDB table not found: Delphi_CommentClustersLLMTopicNames`
      );
      return res.status(404).json({
        status: "error",
        message: "Delphi topic service not available yet.",
        hint: "The table may need to be created by running the Delphi pipeline.",
        report_id,
      });
    }
    logger.error(
      `Error querying DynamoDB or processing request: ${err.message}`
    );
    logger.error(`Error details: ${JSON.stringify(err)}`);

    return res.status(500).json({
      status: "error",
      message: "Error querying DynamoDB",
      error_details: {
        name: err.name,
        message: err.message,
      },
      report_id,
    });
  }
}

const getLogs = async (
  logGroupName: string,
  startTime: number,
  endTime: number,
  filterPattern: string,
  job_id: string
): Promise<FilteredLogEvent[]> => {
  if (Config.awsLogGroupName === "docker") {
    return [
      {
        message: `[DELPHI JOB ${job_id.slice(
          -8
        )}] INFO: view logs in console! - ${Date.now()}`,
      },
    ];
  } else {
    let allEvents: FilteredLogEvent[] = [];
    let nextToken: string | undefined = undefined;

    try {
      do {
        const command = new FilterLogEventsCommand({
          logGroupName: logGroupName,
          startTime: startTime,
          endTime: endTime,
          filterPattern: filterPattern,
          nextToken: nextToken,
        });

        const response = await (logsClient as any).send(command);

        if (response.events) {
          allEvents.push(...response.events);
        }

        nextToken = response.nextToken;
      } while (nextToken);

      return allEvents;
    } catch (err) {
      logger.error("Error fetching logs:", err);
      throw err;
    }
  }
};

export async function handle_GET_delphi_job_logs(req: Request, res: Response) {
  const job_id = req.query.job_id as string;
  const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
  try {
    const logs = await getLogs(
      Config.awsLogGroupName,
      threeHoursAgo,
      Date.now(),
      `"[DELPHI JOB ${job_id.slice(0, 8)}"`,
      job_id
    );
    return res.json(logs);
  } catch (error) {
    logger.error(`Failed to retrieve logs for id ${job_id}`, error);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to retrieve logs" });
  }
}

export async function handle_GET_delphi_queue_position(req: Request, res: Response) {
  const report_id = req.query.report_id as string;
  if (!report_id) {
    return res.status(400).json({ status: "error", message: "report_id is required" });
  }

  try {
    const zid = await getZidFromReport(report_id);
    if (!zid) {
      return res.status(404).json({ status: "error", message: "Conversation not found for report" });
    }
    const conversation_id = zid.toString();

    const tableName = "Delphi_JobQueue";
    const statusIndex = "StatusCreatedIndex";
    const workerCount = parseInt(req.query.workerCount as string || "3", 10);

    // 1. Find this conversation's most recent PENDING or PROCESSING job
    const pendingResult = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: statusIndex,
      KeyConditionExpression: "#s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":status": "PENDING" },
      ScanIndexForward: true, // oldest first for FIFO order
    }));

    const pendingJobs = pendingResult.Items || [];
    
    // Find this conversation's job
    const myJobIndex = pendingJobs.findIndex((j: any) => j.conversation_id === conversation_id);
    
    // 2. Count active (PROCESSING) jobs
    const activeResult = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: statusIndex,
      KeyConditionExpression: "#s = :status",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":status": "PROCESSING" },
      Select: "COUNT",
    }));

    const activeCount = activeResult.Count || 0;
    const pendingCount = pendingJobs.length;

    // 3. If job not in pending, check if it's currently processing
    let jobId: string | null = null;
    let queuePosition: number | null = null;

    if (myJobIndex >= 0) {
      queuePosition = myJobIndex + 1;
      jobId = pendingJobs[myJobIndex].job_id;
    } else {
      // Check if processing
      const processingResult = await docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "PROCESSING" },
      }));
      const processingJobs = (processingResult.Items || []).filter((j: any) => j.conversation_id === conversation_id);
      if (processingJobs.length > 0) {
        jobId = processingJobs[0].job_id;
        return res.json({
          queued: false,
          active: true,
          jobId,
          activeJobCount: activeCount,
          waitingJobCount: pendingCount,
          workerCount,
        });
      }
      return res.json({ queued: false });
    }

    // 4. Compute rolling average from completed jobs (last 50)
    let rollingAvgSeconds: number | null = null;
    try {
      const completedResult = await docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "COMPLETED" },
        ScanIndexForward: false, // newest first
        Limit: 50,
      }));
      
      const completed = completedResult.Items || [];
      const durations: number[] = [];
      for (const job of completed) {
        const startStr = job.started_at;
        const endStr = job.completed_at;
        if (startStr && endStr && startStr.length > 0 && endStr.length > 0) {
          const start = new Date(startStr).getTime();
          const end = new Date(endStr).getTime();
          if (!isNaN(start) && !isNaN(end) && end > start) {
            durations.push((end - start) / 1000);
          }
        }
      }
      if (durations.length > 0) {
        rollingAvgSeconds = Math.ceil(durations.reduce((a, b) => a + b, 0) / durations.length);
      }
    } catch (err: any) {
      logger.warn(`Could not compute rolling average: ${err.message}`);
    }

    const defaultJobSeconds = 1200; // 20 min default for Delphi jobs
    const effectiveJobSeconds = rollingAvgSeconds ?? defaultJobSeconds;
    const effectiveConcurrency = Math.max(1, workerCount);
    const estimatedWaitSeconds = Math.ceil(
      ((Math.max(0, queuePosition - 1) + activeCount) / effectiveConcurrency) * effectiveJobSeconds
    );

    return res.json({
      queued: true,
      jobId,
      queuePosition,
      waitingJobCount: pendingCount,
      activeJobCount: activeCount,
      workerCount,
      estimatedWaitSeconds,
      rollingAvgJobSeconds: rollingAvgSeconds,
    });
  } catch (err: any) {
    logger.error(`Error in Delphi queue position: ${err.message}`);
    return res.status(500).json({ status: "error", message: err.message });
  }
}

export async function handle_GET_delphi_queue_stats(req: Request, res: Response) {
  try {
    const tableName = "Delphi_JobQueue";
    const statusIndex = "StatusCreatedIndex";

    const [pending, processing, completed, failed] = await Promise.all([
      docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "PENDING" },
        Select: "COUNT",
      })),
      docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "PROCESSING" },
        Select: "COUNT",
      })),
      docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "COMPLETED" },
        Select: "COUNT",
      })),
      docClient.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": "FAILED" },
        Select: "COUNT",
      })),
    ]);

    return res.json({
      backend: "dynamodb",
      stats: {
        pending: pending.Count || 0,
        processing: processing.Count || 0,
        completed: completed.Count || 0,
        failed: failed.Count || 0,
      },
    });
  } catch (err: any) {
    logger.error(`Error in Delphi queue stats: ${err.message}`);
    return res.status(500).json({ status: "error", message: err.message });
  }
}
