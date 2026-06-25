-- Audit log (product feature #6, Governance Controls).
--
-- Append-only record of sensitive reads and actions: who (actor) did what
-- (action) to which target, when, with non-PII metadata. The application
-- only ever INSERTs and SELECTs from this table — it never UPDATEs or
-- DELETEs. Retention/purge of audit rows is intentionally NOT handled here;
-- if a future retention policy needs to age out audit rows it must do so via
-- a privileged maintenance path that is exempt from the immutability guard
-- below (e.g. by temporarily disabling the trigger inside a controlled job).
--
-- `tenant_id` leads every key so the single-tenant OSS schema extends to a
-- future multi-tenant mode without a rewrite, matching sessions/events.

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id   TEXT        NOT NULL,
  actor       TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB,
  PRIMARY KEY (tenant_id, id)
);

-- Primary query path: newest-first within a tenant.
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_occurred
  ON audit_log (tenant_id, occurred_at DESC, id DESC);

-- Immutability guard (doc 25 "audit immutability"). A BEFORE UPDATE OR DELETE
-- trigger that always RAISEs makes the table append-only at the database
-- level: even a compromised or buggy application path cannot rewrite or erase
-- history. INSERT and SELECT are unaffected. A deliberate maintenance job that
-- must age out rows would `ALTER TABLE audit_log DISABLE TRIGGER
-- audit_log_no_mutate` under its own privileged transaction — the app role
-- never does this.
CREATE OR REPLACE FUNCTION audit_log_reject_mutation()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutate ON audit_log;
CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_reject_mutation();
