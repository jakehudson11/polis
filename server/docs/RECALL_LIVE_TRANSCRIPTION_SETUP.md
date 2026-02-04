# Recall.ai Live Transcription Setup

## Current Status

✅ **Bot Configuration**: Updated to use Recall.ai's **built-in native transcription** (no third-party required)  
✅ **Webhook Handler**: Configured to receive `transcript.data` and `transcript.partial_data` events  
✅ **Database Schema**: Ready to store transcript segments in real-time  
✅ **Participant Matching**: Automatic matching of meeting participants to Polis participants  

## What's Configured

### 1. Bot Creation (`server/src/services/recallService.ts`)

The bot is now configured to use Recall.ai's built-in native transcription service:

- **Primary**: Uses `recallai_streaming` provider with Recall.ai's native transcription (no third-party credentials needed)
- **Mode**: `prioritize_low_latency` for real-time transcription (can be changed to `prioritize_accuracy` for post-meeting)
- **Fallback**: Uses `meeting_captions` (platform-native) if webhook URL is localhost
- **Real-time Endpoints**: Configured to send `transcript.data`, `transcript.partial_data`, and `transcript.done` events to webhook

### 2. Webhook Handler (`server/src/routes/meetings.ts`)

The webhook endpoint handles:
- `transcript.data` - Final transcript segments (complete utterances)
- `transcript.partial_data` - Partial/streaming transcript data (real-time updates)
- `transcript.done` - Transcription complete event
- `bot.participant.join` - Participant joins meeting
- `bot.participant.leave` - Participant leaves meeting
- `bot.status_change` - Bot status updates

### 3. Database Storage

Transcript segments are stored in `transcript_segments` table with:
- Speaker identification (linked to Polis `pid` when matched)
- Timestamps (relative to meeting start)
- Text content
- Confidence scores
- Language detection

## What You Need to Configure

### Step 1: Configure Webhook URL (Production)

**No transcription provider setup needed!** Recall.ai's built-in transcription works out of the box.

For local development, webhooks won't work (Recall.ai blocks localhost). For production:

1. Set up a publicly accessible webhook URL:
   ```
   https://your-domain.com/api/v3/meetings/webhook/recall
   ```

2. Update your `.env`:
   ```bash
   RECALL_WEBHOOK_SECRET=your_webhook_secret_from_recall_dashboard
   ```

3. The webhook URL is automatically included when creating bots (if not localhost)

### Step 2: Test Live Transcription

1. **Create a meeting** (with a real meeting URL, not localhost):
   ```bash
   curl -X POST "https://your-domain.com/api/v3/meetings" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "meeting_url": "https://teams.microsoft.com/l/meetup-join/...",
       "zid": 1,
       "group_id": 1,
       "title": "Test Live Transcription"
     }'
   ```

2. **Join the meeting** and speak

3. **Check transcript segments**:
   ```bash
   curl -X GET "https://your-domain.com/api/v3/meetings/MEETING_ID/transcripts?since=2025-12-26T00:00:00Z" \
     -H "Authorization: Bearer YOUR_API_KEY"
   ```

## How It Works

### Real-Time Flow

1. **Bot Joins Meeting**: When you create a meeting, Recall.ai bot joins with streaming transcription enabled
2. **Live Transcription**: As participants speak, Recall.ai sends:
   - `transcript.partial_data` events (streaming/partial text)
   - `transcript.data` events (finalized segments)
3. **Webhook Processing**: Your webhook receives events and stores them in `transcript_segments` table
4. **Agent Polling**: Your n8n workflows can poll `/api/v3/meetings/:meeting_id/transcripts?since=TIMESTAMP` to get new segments

### Participant Matching

Participants are automatically matched to Polis `pid`s using:
1. **Email matching** (most reliable)
2. **Name matching** (fuzzy fallback)
3. **Manual linking** via `/api/v3/meetings/:meeting_id/attendance/:recall_participant_id/link`

## Troubleshooting

### No Transcripts Received

1. **Check webhook URL**: Must be publicly accessible (not localhost)
2. **Check webhook secret**: Verify `RECALL_WEBHOOK_SECRET` matches Recall.ai dashboard
3. **Check bot status**: Verify bot successfully joined meeting
4. **Check server logs**: `docker logs polis-dev-server-1 | grep transcript`

### Partial Data Not Working

- `transcript.partial_data` events require `recallai_streaming` provider (not `meeting_captions`)
- Ensure webhook URL is configured and not localhost
- Check that `realtime_endpoints` is included in bot creation
- Verify transcription mode is set to `prioritize_low_latency` for real-time

### Local Development

For local testing:
- Use `meeting_captions` (platform-native) - works without webhook but less reliable
- Or use a tunneling service (ngrok, Cloudflare Tunnel) to expose localhost webhook

## API Endpoints

### Create Meeting (with live transcription)
```
POST /api/v3/meetings
{
  "meeting_url": "https://...",
  "zid": 1,
  "group_id": 1,
  "title": "Meeting Title"
}
```

### Get Transcripts (poll for new segments)
```
GET /api/v3/meetings/:meeting_id/transcripts?since=2025-12-26T00:00:00Z
```

### Get Speaking Time Stats
```
GET /api/v3/meetings/:meeting_id/speaking-time
```

## Next Steps

1. ✅ Bot configuration updated for live transcription (using Recall.ai's built-in native transcription)
2. ⏳ Configure production webhook URL
3. ⏳ Test with real meeting
4. ⏳ Set up n8n workflows to poll transcripts and analyze in real-time

## Transcription Modes

Recall.ai's built-in transcription supports two modes:

- **`prioritize_low_latency`** (default): Real-time transcription with minimal delay - best for live analysis
- **`prioritize_accuracy`**: Post-meeting transcription with higher accuracy - better for final transcripts

You can change the mode by modifying the `createBot` call in `server/src/routes/meetings.ts`:
```typescript
await recallService.createBot(meetingUrl, webhookUrl, "prioritize_accuracy");
```

