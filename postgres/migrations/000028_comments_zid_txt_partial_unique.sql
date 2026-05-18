-- Migration 000028: allow re-adding text after soft-delete by scoping comment text uniqueness to active rows only.
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_zid_txt_key;
CREATE UNIQUE INDEX IF NOT EXISTS comments_zid_txt_active_uniq ON comments (zid, txt) WHERE active = true;