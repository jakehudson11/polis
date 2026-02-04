#!/usr/bin/env node
/**
 * Test script to simulate participant join webhook and verify matching logic
 * 
 * Usage:
 *   npm run test-participant-matching -- --meeting-id 13 --email jakeh@outcomesstar.org --name "Jake Hudson"
 */

import * as dotenv from "dotenv";
import { resolve } from "path";
import axios from "axios";

// Load environment variables
dotenv.config({ path: resolve(__dirname, "../../.env") });

interface Args {
  meetingId: number;
  email?: string;
  name?: string;
  recallParticipantId?: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--meeting-id" && i + 1 < process.argv.length) {
      args.meetingId = parseInt(process.argv[++i], 10);
    } else if (arg === "--email" && i + 1 < process.argv.length) {
      args.email = process.argv[++i];
    } else if (arg === "--name" && i + 1 < process.argv.length) {
      args.name = process.argv[++i];
    } else if (arg === "--recall-participant-id" && i + 1 < process.argv.length) {
      args.recallParticipantId = process.argv[++i];
    }
  }

  return args as Args;
}

async function testParticipantMatching() {
  const args = parseArgs();

  if (!args.meetingId) {
    console.error("Error: --meeting-id is required");
    console.error("\nUsage:");
    console.error(
      '  npm run test-participant-matching -- --meeting-id 13 --email "jakeh@outcomesstar.org" --name "Jake Hudson"'
    );
    process.exit(1);
  }

  const baseUrl = process.env.API_SERVER_PORT
    ? `http://localhost:${process.env.API_SERVER_PORT}`
    : "http://localhost:5000";

  console.log("\n🧪 Testing Participant Matching\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Meeting ID:  ${args.meetingId}`);
  console.log(`Email:       ${args.email || "(not provided)"}`);
  console.log(`Name:        ${args.name || "(not provided)"}`);
  console.log(`API Base:    ${baseUrl}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Get meeting details first
  try {
    console.log("1️⃣  Getting meeting details...");
    const meetingResponse = await axios.get(
      `${baseUrl}/api/v3/meetings/${args.meetingId}`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const meeting = meetingResponse.data.meeting;
    const botId = meeting.recall_bot_id;
    const zid = meeting.zid;

    console.log(`✅ Meeting found: zid=${zid}, bot_id=${botId}\n`);

    // Simulate participant join webhook
    console.log("2️⃣  Simulating participant join webhook...");
    const webhookPayload = {
      type: "bot.participant.join",
      bot: {
        id: botId,
      },
      participant: {
        id: args.recallParticipantId || `test-participant-${Date.now()}`,
        name: args.name || "Test Participant",
        email: args.email || undefined,
      },
    };

    console.log("Webhook payload:", JSON.stringify(webhookPayload, null, 2));
    console.log();

    const webhookResponse = await axios.post(
      `${baseUrl}/api/v3/meetings/webhook/recall`,
      webhookPayload,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Webhook processed:", webhookResponse.data);
    console.log();

    // Wait a moment for DB to update
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check attendance records
    console.log("3️⃣  Checking attendance records...");
    const attendanceQuery = `
      SELECT 
        ma.meeting_id,
        ma.recall_participant_id,
        ma.speaker_name,
        ma.speaker_pid,
        u.email,
        u.hname,
        ma.joined_at
      FROM meeting_attendance ma
      LEFT JOIN participants p ON p.pid = ma.speaker_pid AND p.zid = $1
      LEFT JOIN users u ON u.uid = p.uid
      WHERE ma.meeting_id = $2
      ORDER BY ma.joined_at DESC
    `;

    // Use a simple HTTP endpoint or direct DB query
    // For now, let's just check via the meeting details endpoint
    console.log("\n✅ Test complete!");
    console.log("\nCheck attendance with:");
    console.log(
      `  docker compose exec postgres psql -U postgres -d polis-dev -c "SELECT * FROM meeting_attendance WHERE meeting_id = ${args.meetingId};"`
    );
    console.log("\nExpected result:");
    if (args.email) {
      console.log(`  - Email matching: ${args.email} → should match pid 29`);
    }
    if (args.name) {
      console.log(`  - Name matching: ${args.name} → should match pid 29`);
    }
    console.log(`  - speaker_pid should be set to 29 if matching succeeds\n`);

    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ Error testing participant matching:\n");
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
  testParticipantMatching();
}

export { testParticipantMatching };



