import { Request, Response } from "express";
import logger from "../../utils/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getZidFromReport } from "../../utils/parameter";
import Config from "../../config";

const dynamoDBConfig: any = {
  region: Config.AWS_REGION || "us-east-1",
};

if (Config.dynamoDbEndpoint) {
  dynamoDBConfig.endpoint = Config.dynamoDbEndpoint;
  dynamoDBConfig.credentials = {
    accessKeyId: "DUMMYIDEXAMPLE",
    secretAccessKey: "DUMMYEXAMPLEKEY",
  };
  logger.info(`Using local DynamoDB at endpoint: ${Config.dynamoDbEndpoint}`);
} else {
  if (Config.AWS_ACCESS_KEY_ID && Config.AWS_SECRET_ACCESS_KEY) {
    dynamoDBConfig.credentials = {
      accessKeyId: Config.AWS_ACCESS_KEY_ID,
      secretAccessKey: Config.AWS_SECRET_ACCESS_KEY,
    };
    logger.info(`Using production DynamoDB with AWS credentials`);
  } else {
    logger.info(`Using default AWS credential provider chain`);
  }
}

const client = new DynamoDBClient(dynamoDBConfig);
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

interface TopicHierarchyNode {
  topic_key: string;
  topic_name: string;
  layer_id: number;
  parent_topic_key: string | null;
  is_propagated: boolean;
  source_topic_key: string | null;
  child_count: number;
  cluster_id?: number | null;
  comment_count?: number;
}

export async function handle_GET_delphi_hierarchy(req: Request, res: Response) {
  const reportId = req.query.report_id as string;
  const requestedJobId = req.query.job_id as string | undefined;

  if (!reportId) {
    return res.status(400).json({ error: "report_id is required" });
  }

  let zid: string | number | null | undefined;
  try {
    zid = await getZidFromReport(reportId);
  } catch (err: any) {
    logger.error(
      `Error resolving report_id '${reportId}' via getZidFromReport: ${err.message}`
    );
    return res.status(404).json({ error: "Report not found" });
  }

  if (zid === null || zid === undefined) {
    return res.status(404).json({ error: "Report not found" });
  }

  try {
    const expressionAttributeValues: Record<string, any> = {
      ":cid": String(zid),
    };

    let keyConditionExpression = "conversation_id = :cid";
    if (requestedJobId) {
      keyConditionExpression += " AND begins_with(job_layer_topic, :jobPrefix)";
      expressionAttributeValues[":jobPrefix"] = `${requestedJobId}#layer#`;
    }

    const allItems: any[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: "Delphi_TopicHierarchy",
          KeyConditionExpression: keyConditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (result.Items) {
        allItems.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const nodes: TopicHierarchyNode[] = allItems.map((item: any) => ({
      topic_key: item.topic_key,
      topic_name: item.topic_name,
      layer_id: Number(item.layer_id),
      parent_topic_key: item.parent_topic_key || null,
      is_propagated: Boolean(item.is_propagated),
      source_topic_key: item.source_topic_key || null,
      child_count: Number(item.child_count || 0),
      cluster_id: item.cluster_id != null ? Number(item.cluster_id) : null,
      comment_count:
        item.comment_count != null ? Number(item.comment_count) : undefined,
    }));

    return res.status(200).json(nodes);
  } catch (err: any) {
    if (err?.name === "ResourceNotFoundException") {
      logger.warn("DynamoDB table Delphi_TopicHierarchy not found, returning []");
      return res.status(200).json([]);
    }

    logger.error(`Error querying Delphi_TopicHierarchy: ${err.message}`);
    if (err.stack) {
      logger.error(err.stack);
    }

    return res.status(200).json([]);
  }
}
