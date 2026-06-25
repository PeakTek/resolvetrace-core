-- Per-tenant key/value settings (governance feature #6, editable retention).
--
-- A tiny string-valued settings store so an admin can override the
-- environment retention defaults at runtime via the portal without a
-- redeploy/restart. Env supplies the default; a row here, when present,
-- overrides it. Keys used by this wave:
--
--   retention.events_days    -- override for RETENTION_EVENTS_DAYS
--   retention.sessions_days  -- override for RETENTION_SESSIONS_DAYS
--   retention.replay_days    -- override for RETENTION_REPLAY_DAYS
--
-- Values are stored as text (the application parses/validates them) so the
-- table stays generic for future settings. `tenant_id` leads the key to match
-- the rest of the schema and keep a future multi-tenant mode rewrite-free.
-- Every admin change is recorded in `audit_log` as `settings.update`; this
-- table itself is freely UPDATE-able (it is current state, not history).

CREATE TABLE IF NOT EXISTS settings (
  tenant_id  TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
