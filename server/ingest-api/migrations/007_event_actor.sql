-- Add the caller-supplied identity decoration (`actor`) to the events table.
--
-- The SDK stamps `actor` on every envelope after `client.identify(...)`
-- (events.json#/definitions/Actor: { userId, traits? }). The wire schema now
-- accepts it; this column persists it verbatim so the identity that was in
-- force at capture time round-trips to the session-detail read side.
--
-- Stored as JSONB (mirrors the `context` column added in migration 002).
-- Nullable so existing rows and producers that never call identify() are
-- unaffected.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS actor JSONB;
