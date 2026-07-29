-- Supporting index for tenant-scoped, time-windowed usage aggregation over the
-- replay manifest (`ReplayManifestStore.aggregateUsage`): a managed deployment
-- rolls up per-tenant replay-session count + total bytes for a billing period
-- by `uploaded_at` (server durable-accept time). The existing PK/index is keyed
-- (tenant_id, session_id, sequence) — good for per-session reads, but not for a
-- (tenant_id, uploaded_at-range) scan. This index serves that offline rollup
-- without touching the ingest hot path.
CREATE INDEX IF NOT EXISTS idx_replay_manifest_tenant_uploaded
  ON replay_manifest (tenant_id, uploaded_at);
