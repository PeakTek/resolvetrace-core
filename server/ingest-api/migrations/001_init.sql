-- Initial schema: sessions + events, plus migration bookkeeping.
-- Single-tenant OSS: `tenant_id` is still the leading key so a future
-- multi-tenant mode drops in without a rewrite.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  tenant_id         TEXT        NOT NULL,
  session_id        TEXT        NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  ended_reason      TEXT,
  app_version       TEXT,
  release_channel   TEXT,
  user_anon_id      TEXT,
  client            JSONB,
  event_count       INTEGER,
  replay_chunk_count INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_started
  ON sessions (tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  tenant_id            TEXT        NOT NULL,
  event_id             TEXT        NOT NULL,
  session_id           TEXT,
  type                 TEXT        NOT NULL,
  captured_at          TIMESTAMPTZ NOT NULL,
  attributes           JSONB,
  scrubber             JSONB       NOT NULL,
  sdk                  JSONB       NOT NULL,
  clock_skew_detected  BOOLEAN     NOT NULL DEFAULT FALSE,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_session
  ON events (tenant_id, session_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_events_captured
  ON events (tenant_id, captured_at DESC);
