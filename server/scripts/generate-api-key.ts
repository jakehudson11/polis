#!/usr/bin/env node
/**
 * Script to generate API keys for external agents (n8n, etc.)
 * 
 * Usage:
 *   npm run generate-api-key -- --name "n8n-production"
 *   npm run generate-api-key -- --name "dev-agent" --created-by 1
 */

import * as dotenv from "dotenv";
import { resolve } from "path";

// Load environment variables from project root
dotenv.config({ path: resolve(__dirname, "../../.env") });

import crypto from "crypto";
import pgQuery from "../src/db/pg-query";
import Config from "../src/config";

interface Args {
  name: string;
  createdBy?: number;
  canReadTranscripts?: boolean;
  canPostComments?: boolean;
  canManageMeetings?: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    name: "",
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--name" && i + 1 < process.argv.length) {
      args.name = process.argv[++i];
    } else if (arg === "--created-by" && i + 1 < process.argv.length) {
      args.createdBy = parseInt(process.argv[++i], 10);
    } else if (arg === "--can-read-transcripts") {
      args.canReadTranscripts = true;
    } else if (arg === "--can-post-comments") {
      args.canPostComments = true;
    } else if (arg === "--can-manage-meetings") {
      args.canManageMeetings = true;
    }
  }

  return args;
}

async function generateApiKey() {
  const args = parseArgs();

  if (!args.name) {
    console.error("Error: --name is required");
    console.error("\nUsage:");
    console.error('  npm run generate-api-key -- --name "n8n-production"');
    console.error('  npm run generate-api-key -- --name "dev-agent" --created-by 1');
    process.exit(1);
  }

  // Generate a secure random API key (32 bytes = 64 hex characters)
  const apiKey = crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

  try {
    // Insert into database
    const query = `
      INSERT INTO api_keys (
        key_hash,
        name,
        created_by,
        can_read_transcripts,
        can_post_comments,
        can_manage_meetings
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING key_id, created_at
    `;

    const result = await pgQuery.queryP(query, [
      keyHash,
      args.name,
      args.createdBy || null,
      args.canReadTranscripts !== false, // default true
      args.canPostComments !== false, // default true
      args.canManageMeetings !== false, // default true
    ]);

    const keyId = result[0].key_id;
    const createdAt = result[0].created_at;

    console.log("\n✅ API Key Generated Successfully!\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Key ID:     ${keyId}`);
    console.log(`Name:       ${args.name}`);
    console.log(`Created:    ${createdAt}`);
    console.log("\n⚠️  IMPORTANT: Save this API key now - it won't be shown again!\n");
    console.log(`API Key:    ${apiKey}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    console.log("Usage in requests:");
    console.log(`  Authorization: Bearer ${apiKey}\n`);
    console.log("Example curl:");
    console.log(
      `  curl -H "Authorization: Bearer ${apiKey}" \\\n` +
        `    ${Config.getServerUrl()}/api/v3/meetings\n`
    );

    process.exit(0);
  } catch (error) {
    console.error("Error generating API key:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  generateApiKey();
}

export { generateApiKey };

