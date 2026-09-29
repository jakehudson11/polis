-- Migration: 000032_add_mod_reason_to_comments
--
-- MOVED from postgres/migrations/000029_add_mod_reason_to_comments.sql
-- (2026-09-29). The repo-root postgres/migrations/ directory is a stale legacy
-- copy of the migration set and is NOT read by anything: the runner at
-- server/bin/run-migrations.sh resolves MIGRATIONS_DIR to
-- server/postgres/migrations. Because the file lived in the dead directory, the
-- column was never created in any Polis database, while
-- server/src/routes/comments.ts unconditionally INSERTs mod_reason -> every
-- POST /api/v3/comments failed with PG 42703
-- (column "mod_reason" of relation "comments" does not exist) -> HTTP 500.
--
-- Original commit: 54ef6771 "Add comment moderation hook and dedupe constraint"

ALTER TABLE comments ADD COLUMN IF NOT EXISTS mod_reason TEXT;
