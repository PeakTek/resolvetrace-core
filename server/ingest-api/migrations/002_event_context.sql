-- Widen the events table for the canonical event taxonomy additions:
-- schema version stamp, per-event global context, and the common
-- severity / duration / http-status fields. All nullable so existing rows
-- and producers that omit them are unaffected.
--
-- `context` is stored verbatim as JSONB so the session-detail view can render
-- release/locale/route/device/etc. in a later wave without another migration.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS context        JSONB,
  ADD COLUMN IF NOT EXISTS severity       TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms    INTEGER,
  ADD COLUMN IF NOT EXISTS http_status    INTEGER;
