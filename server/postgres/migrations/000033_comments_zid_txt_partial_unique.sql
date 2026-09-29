-- Migration: 000033_comments_zid_txt_partial_unique
--
-- MOVED from postgres/migrations/000028_comments_zid_txt_partial_unique.sql
-- (2026-09-29) for the same reason as 000032: that directory is not read by the
-- runner (server/bin/run-migrations.sh -> server/postgres/migrations), so this
-- index change was never applied by any deployment.
--
-- Effect: allow a participant to re-add the same text after a soft-delete
-- (active = false) by scoping comment-text uniqueness to active rows only.
--
-- Original commit: 54ef6771 "Add comment moderation hook and dedupe constraint"

ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_zid_txt_key;

CREATE UNIQUE INDEX IF NOT EXISTS comments_zid_txt_active_uniq
  ON comments (zid, txt)
  WHERE active = true;
