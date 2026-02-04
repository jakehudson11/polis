# Polis AI Extensions

Polis includes optional AI-powered features that enhance the platform's capabilities. These extensions are optional and require API keys from third-party AI providers.

## Seed Comment Generator

### Overview

The Seed Comment Generator uses OpenAI's GPT-4 to automatically generate initial comments for a conversation. This helps bootstrap discussions by providing a diverse set of perspectives for participants to react to.

### Features

- **AI-Powered Generation**: Uses GPT-4 Turbo to generate thoughtful, diverse comments
- **Context-Aware**: Generates comments based on conversation topic, description, and questionnaire responses
- **Balanced Perspectives**: Creates both consensus-building and polarizing statements (50/50 split)
- **Character Limit**: Automatically enforces 140-character limit per comment
- **Auto-Approval**: Generated comments are automatically approved and flagged as seeds

### How It Works

1. **Context Building**: Collects conversation metadata and questionnaire responses
2. **AI Generation**: Calls OpenAI API to generate 25-40 seed comments
3. **Comment Creation**: Inserts comments into database with `is_seed = true` flag
4. **Auto-Voting**: Each seed comment receives a neutral "pass" vote

### Configuration

**Required Environment Variable:**
```bash
OPENAI_API_KEY=sk-...
```

**Optional Configuration:**
```typescript
// Default settings (can be modified in server/src/utils/seedCommentGenerator.ts)
const TARGET_COUNT = 35;  // Number of comments to generate
const MIN_COUNT = 25;     // Minimum acceptable
const MAX_COUNT = 40;     // Maximum allowed
```

### API Endpoints

#### Generate Seed Comments

```http
POST /api/v3/conversations/:conversation_id/generate-seed-comments
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Caller must be conversation owner
- Conversation must have questionnaire responses
- OpenAI API key must be configured

**Response:**
```json
{
  "success": true,
  "count": 32,
  "totalGenerated": 35,
  "context": "Generated context from questionnaire...",
  "comments": [
    "Comment text 1",
    "Comment text 2",
    ...
  ],
  "results": [
    {"txt": "Comment text 1", "status": "success", "tid": 1},
    {"txt": "Comment text 2", "status": "success", "tid": 2}
  ]
}
```

#### Submit Seed Comments

```http
POST /api/v3/conversations/:conversation_id/submit-seed-comments
Authorization: Bearer <jwt_token>
```

Marks seed comments as submitted, setting `seed_comments_submitted = true` on the conversation.

### Database Schema

**Comments Table Enhancement:**
```sql
ALTER TABLE comments ADD COLUMN is_seed BOOLEAN DEFAULT FALSE;
```

**Conversations Table Enhancement:**
```sql
ALTER TABLE conversations ADD COLUMN seed_comments_submitted BOOLEAN DEFAULT FALSE;
```

### Usage Example

```bash
# Generate seed comments
curl -X POST https://your-polis-instance.com/api/v3/conversations/abc123/generate-seed-comments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Submit seed comments (make them visible to participants)
curl -X POST https://your-polis-instance.com/api/v3/conversations/abc123/submit-seed-comments \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Implementation Details

**Location:**
- Generator: `server/src/utils/seedCommentGenerator.ts`
- Routes: `server/src/routes/seedComments.ts`
- Context Builder: `server/src/utils/contextBuilder.ts`

**Strategy:**
The generator uses a specific prompt strategy:
- 50% universal-value comments (statements most people might agree with)
- 50% polarizing comments (statements that reveal disagreement)
- Avoids inflammatory language
- Maintains 140-character limit
- Generates plain text, one comment per line

## Delphi Service

### Overview

Delphi is Polis's AI-powered analysis service that creates groups, generates titles and descriptions, and produces spatial visualizations of conversation data.

### Features

- **Group Creation**: Automatically identifies opinion clusters from PCA results
- **AI-Generated Titles**: Creates human-readable titles for each opinion group
- **Group Descriptions**: Generates detailed descriptions of what each group believes
- **Spatial Maps**: Creates DataMapPlot visualizations showing comment/participant relationships
- **Topic Extraction**: Identifies key topics and themes from conversation data

### Configuration

**Required Environment Variables:**
```bash
ANTHROPIC_API_KEY=sk-ant-...
```

**Optional Configuration:**
```bash
# Local LLM (alternative to Anthropic)
OLLAMA_HOST=http://ollama:11434
OLLAMA_MODEL=llama2

# DynamoDB for job queue (production)
DYNAMODB_ENDPOINT=https://dynamodb.us-east-1.amazonaws.com

# S3 for visualization storage
AWS_S3_BUCKET_NAME=polis-delphi
AWS_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
```

### Components

1. **UMAP Narrative Pipeline**
   - Generates embeddings for comments
   - Performs UMAP dimensionality reduction
   - Creates HDBSCAN clusters
   - Generates narrative reports

2. **Topic Agenda System**
   - Extracts topics from conversation
   - Allows participants to prioritize topics
   - Stored in `topic_agenda_selections` table

3. **Visualization Generation**
   - DataMapPlot static visualizations
   - Consensus/divisive comment analysis
   - Group-specific spatial maps

### API Endpoints

```http
GET /api/v3/delphi/conversations/:conversation_id/groups
GET /api/v3/delphi/conversations/:conversation_id/topics
GET /api/v3/delphi/conversations/:conversation_id/visualizations/:viz_id
```

### Database Tables

**Topic Agenda:**
```sql
CREATE TABLE topic_agenda_selections (
  id SERIAL PRIMARY KEY,
  zid INTEGER REFERENCES conversations(zid),
  pid INTEGER REFERENCES participants(pid),
  topic_key TEXT NOT NULL,
  selected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Implementation Details

**Location:**
- Service: `delphi/`
- Pipeline: `delphi/umap_narrative/`
- Job System: `delphi/scripts/job_poller.py`

**Technology Stack:**
- Python 3.11+
- Anthropic Claude for AI generation
- UMAP for dimensionality reduction
- HDBSCAN for clustering
- DataMapPlot for visualization

## Best Practices

### Seed Comment Generator

1. **Questionnaire First**: Ensure participants complete questionnaires before generating seeds
2. **Review Before Submitting**: Review generated comments for quality
3. **Delete Poor Comments**: Remove any generated comments that don't fit the conversation
4. **Submit When Ready**: Only call submit endpoint when you're satisfied with the seed set

### Delphi Service

1. **Wait for Sufficient Data**: Delphi works best with 50+ participants and 100+ comments
2. **Resource Intensive**: Delphi analysis can be computationally expensive
3. **Cache Results**: Delphi results are cached in DynamoDB and S3
4. **Monitor Jobs**: Use the Delphi job poller to monitor long-running analyses

## Troubleshooting

### Seed Comment Generator

**Problem**: "No questionnaire found" error
- **Solution**: Ensure conversation has questionnaire setup and responses

**Problem**: Comments not appearing
- **Solution**: Check that `submit-seed-comments` endpoint was called

**Problem**: Generation fails
- **Solution**: Verify OPENAI_API_KEY is set and valid

### Delphi Service

**Problem**: Delphi analysis not running
- **Solution**: Check that Delphi service is running and ANTHROPIC_API_KEY is set

**Problem**: Visualizations not loading
- **Solution**: Verify S3 bucket is configured and accessible

**Problem**: Out of memory errors
- **Solution**: Increase DELPHI_CONTAINER_MEMORY setting

## Cost Considerations

### OpenAI (Seed Comments)
- Model: GPT-4 Turbo
- Approximate cost per generation: $0.10-0.20
- Based on ~2000 input tokens + ~500 output tokens

### Anthropic (Delphi)
- Model: Claude 3 (Sonnet or Opus)
- Approximate cost per conversation: $0.50-2.00
- Varies based on comment count and complexity

## Future Enhancements

Planned improvements to AI extensions:

1. **Multilingual Support**: Generate seed comments in multiple languages
2. **Custom Prompts**: Allow customization of seed generation prompts
3. **Iterative Refinement**: Ability to regenerate specific comments
4. **Real-time Delphi**: Stream Delphi analysis results as they're generated
5. **Alternative LLM Providers**: Support for additional AI providers (Cohere, Gemini, etc.)
