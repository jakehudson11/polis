#!/usr/bin/env node
/**
 * Test script for meeting API
 * 
 * Usage:
 *   npm run test-meeting-api -- --meeting-url "https://teams.microsoft.com/meet/..." --zid 42 --group-id 5 --api-key YOUR_KEY
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
import axios from "axios";

// Load environment variables
dotenv.config({ path: resolve(__dirname, "../../.env") });

interface Args {
  meetingUrl: string;
  zid: number;
  groupId: number;
  apiKey?: string;
  title?: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--meeting-url" && i + 1 < process.argv.length) {
      args.meetingUrl = process.argv[++i];
    } else if (arg === "--zid" && i + 1 < process.argv.length) {
      args.zid = parseInt(process.argv[++i], 10);
    } else if (arg === "--group-id" && i + 1 < process.argv.length) {
      args.groupId = parseInt(process.argv[++i], 10);
    } else if (arg === "--api-key" && i + 1 < process.argv.length) {
      args.apiKey = process.argv[++i];
    } else if (arg === "--title" && i + 1 < process.argv.length) {
      args.title = process.argv[++i];
    }
  }

  return args as Args;
}

async function testMeetingAPI() {
  const args = parseArgs();

  if (!args.meetingUrl || !args.zid || !args.groupId) {
    console.error("Error: Missing required arguments");
    console.error("\nUsage:");
    console.error(
      '  npm run test-meeting-api -- --meeting-url "https://teams.microsoft.com/meet/..." --zid 42 --group-id 5 --api-key YOUR_KEY'
    );
    process.exit(1);
  }

  const apiKey = args.apiKey || process.env.TEST_API_KEY;
  if (!apiKey) {
    console.error("Error: API key required (--api-key or TEST_API_KEY env var)");
    process.exit(1);
  }

  const baseUrl = process.env.API_SERVER_PORT
    ? `http://localhost:${process.env.API_SERVER_PORT}`
    : "http://localhost:5000";

  console.log("\n🧪 Testing Meeting API\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Meeting URL: ${args.meetingUrl}`);
  console.log(`ZID:         ${args.zid}`);
  console.log(`Group ID:    ${args.groupId}`);
  console.log(`API Base:    ${baseUrl}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  try {
    // Test 1: Create meeting
    console.log("1️⃣  Creating meeting...");
    const createResponse = await axios.post(
      `${baseUrl}/api/v3/meetings`,
      {
        meeting_url: args.meetingUrl,
        zid: args.zid,
        group_id: args.groupId,
        title: args.title || "Test Meeting",
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Meeting created successfully!\n");
    console.log(JSON.stringify(createResponse.data, null, 2));

    const meetingId = createResponse.data.meeting_id;
    const botId = createResponse.data.recall_bot_id;

    console.log(`\n📋 Meeting ID: ${meetingId}`);
    console.log(`🤖 Bot ID: ${botId}`);
    console.log(`📊 Status: ${createResponse.data.bot_status}`);

    // Test 2: Get meeting details
    console.log("\n2️⃣  Getting meeting details...");
    const getResponse = await axios.get(
      `${baseUrl}/api/v3/meetings/${meetingId}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
    console.log("✅ Meeting details retrieved:");
    console.log(JSON.stringify(getResponse.data, null, 2));

    // Test 3: List meetings
    console.log("\n3️⃣  Listing meetings...");
    const listResponse = await axios.get(
      `${baseUrl}/api/v3/meetings?zid=${args.zid}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );
    console.log(`✅ Found ${listResponse.data.meetings.length} meeting(s)`);

    console.log("\n✅ All tests passed!\n");
    console.log("Next steps:");
    console.log(`  - Check bot status: GET /api/v3/meetings/${meetingId}`);
    console.log(`  - Poll transcripts: GET /api/v3/meetings/${meetingId}/transcripts`);
    console.log(`  - Get speaking time: GET /api/v3/meetings/${meetingId}/speaking-time`);
    console.log(`  - Post comment: POST /api/v3/meetings/${meetingId}/comments\n`);

    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ Error testing API:\n");
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  testMeetingAPI();
}

export { testMeetingAPI };



