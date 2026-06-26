-- Replay chunk manifest (masked-replay feature #1).
--
-- `POST /v1/replay/complete` now persists one row per durably-uploaded chunk
-- here (after the HeadObject verify) and increments `sessions.replay_chunk_count`.
-- Before this migration the complete leg verified the object but persisted
-- nothing — the manifest is what makes a captured session durable, linkable,
-- listable for playback, and purgeable by exact object key.
--
-- The row records the canonical object key, the verified byte length, the
-- client-asserted sha256, and the SDK scrubber/masking report carried on the
-- complete request (`scrubber` in replay.json) so an auditor can confirm the
-- masking configuration that was in force when the chunk was captured (audit
-- parity, doc-18 replay_defaults).
--
-- Uniqueness is per (tenant_id, session_id, sequence): a repeated `/complete`
-- for the same sequence is idempotent — it updates the existing row in place
-- and does NOT double-increment the counter (the route only increments on a
-- first-seen insert).

CREATE TABLE IF NOT EXISTS replay_manifest (
  tenant_id    TEXT        NOT NULL,
  session_id   TEXT        NOT NULL,
  sequence     INTEGER     NOT NULL,
  key          TEXT        NOT NULL,
  bytes        BIGINT      NOT NULL,
  sha256       TEXT        NOT NULL,
  -- SDK scrubber/masking report (replay.json `scrubber`), stored verbatim for
  -- audit parity. Nullable so a producer that omits it still records a row.
  scrubber     JSONB,
  -- When the SDK reported it uploaded the chunk (client clock); distinct from
  -- `uploaded_at`, which is the server's durable-accept time.
  client_uploaded_at TIMESTAMPTZ,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, sequence)
);

-- Read-side: list a session's chunks in playback order; purge/erasure: sweep a
-- session's keys. Both query by (tenant_id, session_id).
CREATE INDEX IF NOT EXISTS idx_replay_manifest_session
  ON replay_manifest (tenant_id, session_id, sequence);
