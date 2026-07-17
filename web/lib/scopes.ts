/**
 * Portal scope vocabulary + gating helper (isomorphic, no secrets).
 *
 * The portal UI gates on these neutral scope STRINGS carried in the session —
 * never on role names (roles are a deployment concept mapped to scopes on the
 * server). The data plane enforces the same scopes on the per-tenant credential.
 */

/** Read sessions, timeline, problem reports, support-code lookup. */
export const SCOPE_SESSION_READ = "session:read";
/** Read the audit log + view replay. */
export const SCOPE_AUDIT_READ = "audit:read";
/**
 * Destructive tenant-admin surface: retention / replay / webhook settings,
 * purge, targeted session delete.
 */
export const SCOPE_TENANT_ADMIN = "tenant:admin";

/** True when the given scope list grants `scope`. */
export function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}
