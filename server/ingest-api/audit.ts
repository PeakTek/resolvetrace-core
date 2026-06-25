/**
 * Audit log — action constants and the non-fatal writer helper.
 *
 * The audit log is an append-only record of sensitive reads and actions
 * (governance feature #6, doc 25 audit-immutability gate). The table schema
 * and immutability guard live in migration `004_audit_log.sql`; the Postgres
 * sink/repository live in `postgres.ts`; the in-memory sink lives in
 * `in-memory-sinks.ts`.
 *
 * IMPORTANT: audit writes must NEVER break the primary request. Handlers call
 * `recordAudit(...)`, which swallows any sink failure (logging it and bumping
 * an in-process counter) so a degraded audit path degrades observability, not
 * the user-facing operation. The failure IS surfaced — it is logged at error
 * level and counted — it is just not propagated.
 */

import type { Logger } from "pino";
import type { AuditRecordInput, AuditSink } from "./types.js";

/**
 * Canonical audit action names. Other agents/waves MUST reuse these constants
 * rather than re-typing the strings so the action vocabulary stays consistent
 * across the audit log:
 *
 *  - A1 (this wave) writes: SESSION_VIEW, SUPPORT_CODE_LOOKUP, AUTH_LOGIN,
 *    AUTH_LOGIN_FAILED.
 *  - A2 (retention + deletion) writes: SESSION_DELETE, RETENTION_PURGE.
 *  - Wave 24 (replay access) writes: REPLAY_ACCESS.
 *  - Settings mutation (A3/A2, wherever settings become mutable) writes:
 *    SETTINGS_UPDATE.
 */
export const AuditAction = {
  /** GET portal session detail. */
  SESSION_VIEW: "session.view",
  /** Resolve a session by its support code (record hit/miss, not the code). */
  SUPPORT_CODE_LOOKUP: "support_code.lookup",
  /** Portal login succeeded. */
  AUTH_LOGIN: "auth.login",
  /** Portal login attempt failed. */
  AUTH_LOGIN_FAILED: "auth.login_failed",
  /** Settings changed (wired where settings become mutable). */
  SETTINGS_UPDATE: "settings.update",
  /** Targeted session deletion / right-to-erasure (A2). */
  SESSION_DELETE: "session.delete",
  /** Retention purge run (A2). */
  RETENTION_PURGE: "retention.purge",
  /** Replay artifact accessed (Wave 24 emits this). */
  REPLAY_ACCESS: "replay.access",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Stable principal label used when the caller authenticated with an API
 * key / bearer rather than a named user. We NEVER log the secret; this is a
 * fixed, non-sensitive identifier for the portal's server-to-server bearer.
 */
export const PRINCIPAL_PORTAL_SERVICE = "portal-service";

/**
 * Scope that authorizes reading the audit log. This is the RBAC seam: admin
 * principals carry `audit:read` in their scopes (the OSS single-tenant
 * principal does, by default); viewer principals do not, and the audit query
 * endpoint returns 403 for them. The role -> scope mapping is owned by the
 * tenant resolver / portal; the endpoint only checks the scope.
 */
export const SCOPE_AUDIT_READ = "audit:read";

/** Process-local counter of audit-write failures, for observability. */
let auditWriteFailures = 0;

/** Total audit-write failures since process start. Visible for tests/metrics. */
export function auditWriteFailureCount(): number {
  return auditWriteFailures;
}

/** Reset the failure counter. Visible for tests. */
export function resetAuditWriteFailureCount(): void {
  auditWriteFailures = 0;
}

/**
 * Write an audit record without ever throwing. A sink failure is logged at
 * error level and counted; it does not propagate to the caller. Returns
 * `true` on success, `false` if the write failed.
 */
export async function recordAudit(
  sink: AuditSink,
  tenantId: string,
  record: AuditRecordInput,
  logger?: Pick<Logger, "error">
): Promise<boolean> {
  try {
    await sink.append(tenantId, record);
    return true;
  } catch (err) {
    auditWriteFailures += 1;
    // Log the failure but never rethrow — the primary request must succeed
    // regardless of audit-log health.
    logger?.error(
      { err, action: record.action, tenantId },
      "audit write failed (non-fatal)"
    );
    return false;
  }
}
