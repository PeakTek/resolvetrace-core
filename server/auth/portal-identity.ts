/**
 * Portal identity token + neutral role→scope defaults.
 *
 * The multi-tenant portal login flow is identity-first: the user authenticates
 * (no tenant yet), then selects a tenant. `tenant-select` must know *which
 * user* is asking without trusting a client-asserted id (anti-spoof). We issue
 * a short-lived, HMAC-signed identity token at login that the portal server
 * presents back on `tenant-select` / `session`; the backend verifies it and
 * reads the subject from the verified payload, never from the request body.
 *
 * This is an HMAC (symmetric) token verified by the same server that signed it
 * — deliberately simple (no external dep, no key distribution). It is the
 * portal-user identity session, distinct from the SDK capture session and from
 * the per-tenant ES256 data-plane key.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Claims carried by the portal identity token. */
export interface PortalIdentityClaims {
  /** Stable user id (e.g. the IdP subject). */
  sub: string;
  email: string;
  roles: string[];
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Sign a portal identity token. Returns `<payload>.<sig>` where `payload` is a
 * base64url JSON blob `{ sub, email, roles, exp }` and `sig` is the base64url
 * HMAC-SHA256 of `payload` under `secret`.
 */
export function signPortalIdentity(
  secret: string,
  claims: PortalIdentityClaims,
  ttlSeconds: number,
  nowMs: number = Date.now()
): string {
  const payload = {
    sub: claims.sub,
    email: claims.email,
    roles: claims.roles,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a portal identity token. Returns the claims on success, or `null` on
 * any failure (bad shape, bad signature, expired). Constant-time signature
 * comparison.
 */
export function verifyPortalIdentity(
  secret: string,
  token: string,
  nowMs: number = Date.now()
): PortalIdentityClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.exp !== "number" || p.exp * 1000 < nowMs) return null;
  if (
    typeof p.sub !== "string" ||
    typeof p.email !== "string" ||
    !Array.isArray(p.roles) ||
    !p.roles.every((r) => typeof r === "string")
  ) {
    return null;
  }
  return { sub: p.sub, email: p.email, roles: p.roles as string[] };
}

/**
 * Neutral default role→scope mapping, used when no `TenantCredentialMinter` is
 * injected (OSS single-tenant). Managed owns its own role→scope mapping inside
 * the minter; core never enforces on the role name, only on the scope strings.
 *
 * Scope meanings (mirrors the RBAC table): `session:read` — sessions/reports;
 * `audit:read` — audit log + replay view; `tenant:admin` — retention/replay/
 * webhook settings, purge, session delete.
 */
export function defaultScopesForRole(role: string): string[] {
  switch (role) {
    case "admin":
      return ["session:read", "audit:read", "tenant:admin"];
    case "engineer":
      return ["session:read", "audit:read"];
    case "support":
    case "viewer":
      return ["session:read"];
    default:
      // Unknown roles get the least privilege that still renders the portal.
      return ["session:read"];
  }
}
