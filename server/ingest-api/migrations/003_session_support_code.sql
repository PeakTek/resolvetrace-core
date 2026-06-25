-- Per-session support code (product feature #4). The server mints a short,
-- human-shareable Crockford base32 code on `/v1/session/start`; the portal
-- resolves a code back to its session.
--
-- Stored normalized (uppercase canonical). New sessions only — no backfill;
-- legacy rows read back NULL. The unique index is partial (WHERE NOT NULL)
-- so those NULL rows don't collide and a collision on generation surfaces as
-- a constraint violation that the sink retries.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS support_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_support_code
  ON sessions (tenant_id, support_code)
  WHERE support_code IS NOT NULL;
