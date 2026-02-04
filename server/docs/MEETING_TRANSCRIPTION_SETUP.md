# Meeting Transcription Setup Guide

This guide walks you through setting up the meeting transcription system with Recall.ai integration.

## Prerequisites

1. Recall.ai account with API credentials
2. PostgreSQL database with migrations applied
3. Node.js environment configured

## Step 1: Configure Environment Variables

Add the following to your `.env` file (or update `example.env`):

```bash
# Recall.ai Configuration
RECALL_API_KEY=your_recall_api_key_here
RECALL_WEBHOOK_SECRET=your_webhook_secret_here
RECALL_API_BASE_URL=https://us-west-2.recall.ai/api/v1  # Optional, defaults to us-west-2
```

**Note:** The webhook secret is used to verify webhook requests from Recall.ai. Make sure it matches what you configure in your Recall.ai dashboard.

## Step 2: Run Database Migrations

Apply the new migrations to your database:

```bash
# If using docker-compose
docker-compose exec server npm run db:migrate

# Or manually run migrations in order:
# 000020_add_topic_key_to_deliberation_groups.sql
# 000021_create_meetings.sql
# 000022_create_meeting_attendance.sql
# 000023_create_transcript_segments.sql
# 000024_create_agent_comments.sql
# 000025_create_api_keys.sql
```

## Step 3: Configure Recall.ai Webhook

1. Log into your Recall.ai dashboard
2. Navigate to Webhook settings
3. Set webhook URL to: `https://your-domain.com/api/v3/meetings/webhook/recall`
4. Set webhook secret to match `RECALL_WEBHOOK_SECRET` in your `.env`
5. Enable the following events:
   - `bot.status_change`
   - `transcript.data`
   - `transcript.done`
   - `bot.participant.join`
   - `bot.participant.leave`

## Step 4: Generate API Keys for n8n/Agents

Generate API keys for your external agents (n8n workflows):

```bash
# Generate a key for n8n production
npm run generate-api-key -- --name "n8n-production"

# Generate a key for development
npm run generate-api-key -- --name "dev-agent" --created-by 1

# Generate a key with specific permissions
npm run generate-api-key -- --name "read-only-agent" \
  --can-read-transcripts \
  --can-post-comments=false \
  --can-manage-meetings=false
```

**Important:** Save the API key immediately - it's only shown once!

## Step 5: Test the API

### Create a Meeting

```bash
curl -X POST https://your-domain.com/api/v3/meetings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_url": "https://zoom.us/j/123456789",
    "zid": 42,
    "group_id": 5,
    "title": "Squad 5 - Topic: Climate Policy"
  }'
```

Response:
```json
{
  "status": "success",
  "meeting_id": 1,
  "recall_bot_id": "abc-123-def",
  "bot_status": "joining",
  "platform": "zoom"
}
```

### Poll Transcripts

```bash
curl -X GET "https://your-domain.com/api/v3/meetings/1/transcripts?since=2025-01-01T10:00:00Z" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Get Speaking Time

```bash
curl -X GET https://your-domain.com/api/v3/meetings/1/speaking-time \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Post a Comment

```bash
curl -X POST https://your-domain.com/api/v3/meetings/1/comments \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Speaking time update: John 30%, Jane 20%, Bob 50%",
    "raise_hand": true,
    "agent_id": "speaking-time-monitor",
    "trigger_type": "scheduled"
  }'
```

## Step 6: Set Up n8n Workflows

### Workflow 1: Create Meeting

1. **HTTP Request Node** (POST)
   - URL: `https://your-domain.com/api/v3/meetings`
   - Method: POST
   - Headers:
     - `Authorization: Bearer YOUR_API_KEY`
     - `Content-Type: application/json`
   - Body:
     ```json
     {
       "meeting_url": "{{ $json.meeting_url }}",
       "zid": {{ $json.zid }},
       "group_id": {{ $json.group_id }},
       "title": "{{ $json.title }}"
     }
     ```

### Workflow 2: Poll Transcripts (Every 10 seconds)

1. **Schedule Trigger** - Run every 10 seconds
2. **HTTP Request Node** (GET)
   - URL: `https://your-domain.com/api/v3/meetings/{{ $json.meeting_id }}/transcripts?since={{ $json.last_poll_time }}`
   - Headers: `Authorization: Bearer YOUR_API_KEY`
3. **If Node** - Check if segments.length > 0
4. **LLM Node** - Analyze transcripts
5. **Set Node** - Update last_poll_time

### Workflow 3: Speaking Time Reporter (Every 15 minutes)

1. **Schedule Trigger** - Run every 15 minutes
2. **HTTP Request Node** (GET)
   - URL: `https://your-domain.com/api/v3/meetings/{{ $json.meeting_id }}/speaking-time`
   - Headers: `Authorization: Bearer YOUR_API_KEY`
3. **Function Node** - Format message:
   ```javascript
   const participants = $json.participants;
   const message = participants.map(p => 
     `${p.speaker_name}: ${p.percentage.toFixed(1)}%`
   ).join(', ');
   return { message: `Speaking time update: ${message}` };
   ```
4. **HTTP Request Node** (POST)
   - URL: `https://your-domain.com/api/v3/meetings/{{ $json.meeting_id }}/comments`
   - Body:
     ```json
     {
       "text": "{{ $json.message }}",
       "raise_hand": true,
       "agent_id": "speaking-time-monitor",
       "trigger_type": "scheduled"
     }
     ```

### Workflow 4: Fact Checker

1. **Trigger** - From transcript polling workflow
2. **LLM Node** - Detect checkable claims
3. **Web Search Node** - Look up facts
4. **HTTP Request Node** (POST) - Post fact-check result to meeting

### Workflow 5: Conflict Moderator

1. **Trigger** - From transcript polling workflow
2. **LLM Node** - Detect conflict/tension
3. **HTTP Request Node** (POST) - Post de-escalation message

## API Reference

### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/v3/meetings/webhook/recall` | None | Receive Recall webhooks |
| `POST` | `/api/v3/meetings` | API Key | Create meeting + dispatch bot |
| `GET` | `/api/v3/meetings` | API Key | List meetings (filter: `?zid=X&group_id=Y&status=Z`) |
| `GET` | `/api/v3/meetings/:id` | API Key | Get meeting details |
| `DELETE` | `/api/v3/meetings/:id` | API Key | End meeting + remove bot |
| `GET` | `/api/v3/meetings/:id/transcripts` | API Key | Poll transcripts (`?since=ISO_TIMESTAMP`) |
| `GET` | `/api/v3/meetings/:id/speaking-time` | API Key | Get speaking time percentages |
| `POST` | `/api/v3/meetings/:id/comments` | API Key | Post comment + raise hand |

### Webhook Events

Recall.ai sends the following events to `/api/v3/meetings/webhook/recall`:

- `bot.status_change` - Bot status updated (joining, in_call, done, etc.)
- `transcript.data` - New transcript segments (real-time)
- `transcript.done` - Transcription complete
- `bot.participant.join` - Participant joined meeting
- `bot.participant.leave` - Participant left meeting

## Troubleshooting

### Bot Not Joining Meeting

1. Check `bot_status` in database: `SELECT * FROM meetings WHERE meeting_id = X`
2. Verify meeting URL is correct and accessible
3. Check Recall.ai dashboard for bot status
4. Review server logs for errors

### Transcripts Not Appearing

1. Verify webhook is configured correctly in Recall.ai dashboard
2. Check webhook secret matches `RECALL_WEBHOOK_SECRET`
3. Review webhook logs: `docker logs polis-dev-server-1 | grep webhook`
4. Verify bot has joined meeting (check `bot_status = 'in_call'`)

### API Key Authentication Failing

1. Verify API key is active: `SELECT * FROM api_keys WHERE name = 'your-key-name'`
2. Check key hash matches: Generate new key if needed
3. Verify `Authorization: Bearer <key>` header format

### Speaking Time Not Calculating

1. Verify transcripts are being stored: `SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = X`
2. Check attendance records: `SELECT * FROM meeting_attendance WHERE meeting_id = X`
3. Ensure `total_speaking_seconds` is being updated (happens automatically via webhook)

## Security Notes

- **Never commit API keys or webhook secrets to version control**
- **Use environment variables for all sensitive configuration**
- **Rotate API keys periodically**
- **Use different keys for different environments (dev/staging/prod)**
- **Monitor API key usage via `last_used_at` field**



