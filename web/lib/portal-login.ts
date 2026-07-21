import { buildSession, type PortalSession } from "./session";

/**
 * Shared helpers for the portal-auth exchange (password login + OIDC callback).
 * Server-only (used by the `/api/auth/*` route handlers).
 */

/** The ingest/portal-API base URL. */
export const INGEST_BASE = (
  process.env.RT_INGEST_URL ?? "http://resolvetrace:4317"
).replace(/\/$/, "");

/**
 * The single tenant this portal instance serves, when it is a per-tenant
 * deployment. Sent on every identity call so the backend refuses users without
 * a membership in THIS tenant — authenticating against the shared IdP must not
 * be enough to enter another tenant's portal. Unset ⇒ every membership is
 * offered (OSS single-tenant, or a multi-workspace portal).
 */
export const PORTAL_TENANT_ID =
  process.env.PORTAL_TENANT_ID?.trim() || undefined;

/** Body fragment carrying the pin (empty when this portal isn't pinned). */
export const tenantPin = (): { tenantId?: string } =>
  PORTAL_TENANT_ID ? { tenantId: PORTAL_TENANT_ID } : {};

/** Success shape returned by the backend login + callback endpoints. */
export interface PortalLoginResult {
  user: { userId: string; email: string; roles: string[] };
  tenants: { id: string; displayName: string }[];
  currentTenantId: string;
  role?: string;
  scopes?: string[];
  identityToken?: string;
  ingestCredential?: { credential: string; expiresAt: number };
}

/** Seal a backend login/callback result into a portal session envelope. */
export function sessionFromLoginResult(data: PortalLoginResult): PortalSession {
  return buildSession({
    sub: data.user.userId,
    email: data.user.email,
    roles: data.user.roles ?? [],
    tenants: data.tenants ?? [],
    currentTenantId: data.currentTenantId,
    role: data.role ?? "",
    scopes: data.scopes ?? [],
    identityToken: data.identityToken,
    ingestBearer: data.ingestCredential?.credential,
    ingestBearerExp: data.ingestCredential?.expiresAt,
  });
}
