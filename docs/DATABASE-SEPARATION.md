# Database Separation: Polis vs Agora

This document explains the database separation between Polis (open-source core) and Agora (proprietary orchestration layer).

## Migration Split

### Polis Core Migrations (Standalone Polis Database)

These migrations create the core Polis platform:

**Base Schema:**
- `000000_initial.sql` - Complete base Polis schema (conversations, comments, votes, participants, users, etc.)

**Core Enhancements:**
- `000001_update_pwreset_table.sql` - Password reset improvements
- `000002_add_xid_constraint.sql` - External ID constraints
- `000003_add_origin_permanent_cookie_columns.sql` - Cookie tracking
- `000004_drop_waitinglist_table.sql` - Cleanup legacy table
- `000005_drop_slack_stripe_canvas.sql` - Cleanup integration tables
- `000006_update_votes_rule.sql` - Vote processing improvements
- `000007_drop_geolocation_fields.sql` - Privacy enhancement
- `000008_add_comment_priority.sql` - Comment ranking
- `000009_add_uuid_to_zinvites.sql` - Invitation system UUIDs
- `000010_create_oidc_user_mappings.sql` - OIDC authentication
- `000011_alter_suzinvites_xid_to_text.sql` - XID improvements
- `000012_create_topic_agenda_selections.sql` - **Delphi core feature** (topic prioritization)
- `000013_create_treevite.sql` - Wave-based invitation system
- `000014_alter_reports_modlevel.sql` - Report improvements
- `000015_add_xid_requirements.sql` - XID validation

**Additional Polis Features:**
- Seed comment support (`is_seed` column in comments)
- Delphi topic agenda system

### Agora Orchestration Migrations (Separate Agora Database)

These migrations create Agora-specific features:

**Delphi Orchestration:**
- `000016_create_conversation_delphi_config.sql` - Agora-specific Delphi configuration

**Deliberation System:**
- `000017_create_deliberation_groups.sql` - Deliberation groups/squads
- `000018_create_deliberation_group_members.sql` - Group membership
- `000019_create_participant_topic_completions.sql` - Topic completion tracking
- `000020_add_topic_key_to_deliberation_groups.sql` - Topic linking

**Meeting Integration:**
- `000021_create_meetings.sql` - Meeting records (Zoom/Teams/etc.)
- `000022_create_meeting_attendance.sql` - Attendance tracking
- `000023_create_transcript_segments.sql` - Real-time transcripts (Recall.ai)
- `000024_create_agent_comments.sql` - AI agent interventions
- `000025_create_api_keys.sql` - External agent API keys
- `000026_create_meeting_oauth_tokens.sql` - OAuth token storage
- `000027_create_meeting_agents.sql` - Meeting agent state

**AI Orchestration:**
- `000028_add_guiding_questions.sql` - Guiding questions generation
- `000029_increase_context_size.sql` - Context size for AI
- `000030_add_initiation_status_fields.sql` - Deliberation initiation status
- `000031_add_research_dossier.sql` - Research dossier generation
- `20260105163549_add_conversation_invitations.sql` - Conversation invitations

## Database Tables

### Polis Database Tables

**Core Tables:**
- `conversations` - Conversation metadata
- `comments` - User comments (includes `is_seed` for AI-generated)
- `votes` - Participant votes
- `votes_latest_unique` - Latest vote per participant/comment
- `participants` - Conversation participants
- `users` - User accounts
- `reports` - Generated reports
- `math_*` - Mathematical analysis cache (PCA, clustering results)

**Authentication:**
- `oidc_user_mappings` - OIDC identity mappings
- `xids` - External identity system
- `zinvites` - Conversation invites
- `suzinvites` - Survey invites
- `treevite_*` - Wave-based invitation system

**Delphi Core:**
- `topic_agenda_selections` - Participant topic prioritization

### Agora Database Tables

**Deliberation:**
- `conversation_delphi_config` - Delphi configuration per conversation
- `deliberation_groups` - Deliberation groups/squads
- `deliberation_group_members` - Group membership (many-to-many)
- `participant_topic_completions` - Topic completion tracking

**Meetings:**
- `meetings` - Meeting records (Zoom/Teams/Google Meet)
- `meeting_attendance` - Participant attendance and speaking time
- `meeting_oauth_tokens` - Encrypted OAuth tokens
- `meeting_agent_state` - AI agent state
- `transcript_segments` - Real-time transcript data
- `agent_comments` - AI agent interventions

**Agora Features:**
- `api_keys` - External agent API keys (n8n, etc.)
- `conversation_invitations` - Invitation token system
- `conversation_join_requests` - Join request approval

**AI Orchestration Metadata:**
- Additional columns on conversations for guiding questions, research dossier, initiation status

## Foreign Key Considerations

### Cross-Database References

Many Agora tables reference `conversations(zid)` from the Polis database. After separation:

**Option 1: Store Polis Conversation ID**
```sql
-- In Agora database
ALTER TABLE deliberation_groups 
ADD COLUMN polis_conversation_id TEXT;

-- Store the Polis conversation identifier
-- Agora backend retrieves conversation details via Polis API
```

**Option 2: Replicate Minimal Conversation Data**
```sql
-- In Agora database
CREATE TABLE agora_conversations (
  id SERIAL PRIMARY KEY,
  polis_zid INTEGER NOT NULL UNIQUE,
  polis_conversation_id TEXT,
  topic TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TIMESTAMP
);

-- Reference this table instead
ALTER TABLE deliberation_groups 
ADD COLUMN agora_conversation_id INTEGER REFERENCES agora_conversations(id);
```

**Recommended: Option 1** - Simpler, maintains single source of truth in Polis.

### User Synchronization

Agora needs to track which Polis users correspond to Agora users:

```sql
-- In Agora database
CREATE TABLE agora_users (
  id SERIAL PRIMARY KEY,
  agora_user_id INTEGER,  -- Internal Agora user ID (if separate auth)
  polis_uid INTEGER NOT NULL UNIQUE,  -- Polis user ID
  email TEXT,
  name TEXT,
  last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Migration Strategy

### Phase 1: Prepare Polis Database

1. **Copy Polis migrations** to polis:
```bash
cp migrations/000000_initial.sql polis/postgres/migrations/
cp migrations/000001_*.sql polis/postgres/migrations/
# ... copy 000000 through 000015
cp migrations/000012_create_topic_agenda_selections.sql polis/postgres/migrations/
```

2. **Create consolidated Polis schema**:
```bash
cd polis/postgres
cat migrations/*.sql > schema-polis-core.sql
```

3. **Add seed comment support**:
```sql
-- Already included in comments table
ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_seed BOOLEAN DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS seed_comments_submitted BOOLEAN DEFAULT FALSE;
```

### Phase 2: Prepare Agora Database

1. **Create Agora migration directory**:
```bash
mkdir -p agora/backend/migrations
```

2. **Copy Agora migrations** (000016+):
```bash
cp migrations/000016_*.sql agora/backend/migrations/000001_conversation_delphi_config.sql
cp migrations/000017_*.sql agora/backend/migrations/000002_deliberation_groups.sql
# ... renumber starting from 000001
```

3. **Add foreign key substitutions**:
```sql
-- Replace direct foreign keys to Polis tables
-- Before:
ALTER TABLE deliberation_groups ADD FOREIGN KEY (zid) REFERENCES conversations(zid);

-- After:
ALTER TABLE deliberation_groups ADD COLUMN polis_conversation_id TEXT NOT NULL;
CREATE INDEX idx_deliberation_groups_polis_conv ON deliberation_groups(polis_conversation_id);
```

### Phase 3: Data Migration

1. **Export current data**:
```sql
-- Export Polis core data
pg_dump -h localhost -U postgres agora \
  -t conversations -t comments -t votes -t participants -t users -t reports \
  -t math_* -t oidc_user_mappings -t topic_agenda_selections \
  > polis-data-export.sql

-- Export Agora data  
pg_dump -h localhost -U postgres agora \
  -t conversation_delphi_config -t deliberation_* -t meetings -t meeting_* \
  -t transcript_segments -t agent_comments -t api_keys \
  -t conversation_invitations \
  > agora-data-export.sql
```

2. **Create new databases**:
```bash
createdb polis
createdb agora-standalone
```

3. **Import data**:
```bash
# Polis
psql -h localhost -U postgres polis < polis/postgres/schema-polis-core.sql
psql -h localhost -U postgres polis < polis-data-export.sql

# Agora
psql -h localhost -U postgres agora-standalone < agora/backend/schema-agora.sql
psql -h localhost -U postgres agora-standalone < agora-data-export.sql
```

4. **Update Agora foreign keys**:
```sql
-- In Agora database, update conversation references
UPDATE deliberation_groups 
SET polis_conversation_id = CAST(zid AS TEXT);

UPDATE meetings 
SET polis_conversation_id = CAST(zid AS TEXT);

-- Drop old zid columns
ALTER TABLE deliberation_groups DROP COLUMN zid;
ALTER TABLE meetings DROP COLUMN zid;
```

## Connection Configuration

### Polis Server

```bash
# .env
DATABASE_URL=postgresql://polis_user:password@polis-db:5432/polis
```

### Agora Backend

```bash
# .env
AGORA_DATABASE_URL=postgresql://agora_user:password@agora-db:5432/agora
POLIS_API_URL=http://polis-api:5000
POLIS_API_KEY=your-api-key-for-server-to-server-auth
```

## Testing Separation

After migration, verify:

1. **Polis standalone works**:
   - Create conversation
   - Submit comments
   - Vote on comments
   - Generate math results
   - Run Delphi analysis

2. **Agora connects to Polis**:
   - Create deliberation group (stores polis_conversation_id)
   - Retrieve conversation from Polis API
   - Create meeting linked to Polis conversation
   - Generate research dossier (calls Polis API for data)

3. **No cross-database queries**:
```bash
# Verify no direct DB connections
grep -r "conversations\|comments\|votes" agora/backend/src/ 
# Should only find API calls, not SQL queries
```

## Rollback Plan

If separation needs to be rolled back:

1. Keep backups of original database
2. Document all changes made
3. Create merge script to recombine databases if needed

```sql
-- Emergency merge script
pg_dump polis | psql combined-db
pg_dump agora-standalone | psql combined-db

-- Restore foreign keys
ALTER TABLE deliberation_groups 
ADD COLUMN zid INTEGER,
ADD FOREIGN KEY (zid) REFERENCES conversations(zid);

UPDATE deliberation_groups dg
SET zid = c.zid
FROM conversations c
WHERE dg.polis_conversation_id = CAST(c.zid AS TEXT);
```

## Best Practices

1. **Always use Polis API** - Agora should never directly query Polis database
2. **Cache Polis data sparingly** - Avoid stale data by fetching from API when needed
3. **Sync user mappings** - Keep `agora_users` table in sync with Polis
4. **Monitor API usage** - Log all Polis API calls from Agora
5. **Version migrations** - Use proper migration versioning for both databases
