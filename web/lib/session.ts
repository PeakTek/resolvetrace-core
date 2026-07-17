/**
 * Portal session — sealed, encrypted cookie payload (pure crypto; no Next
 * request-context imports, so it is unit-testable and usable from both the
 * Edge middleware and Node route handlers / server components).
 *
 * The session is AES-256-GCM encrypted (Web Crypto, available in both runtimes)
 * and stored in an httpOnly cookie. It carries the non-secret identity view
 * (used for route gating + UI) AND, in managed multi-tenant deployments, the
 * secret per-tenant data-plane bearer + the backend identity token — encrypted
 * so neither is readable in the browser. Request-context helpers
 * (getSession / setSessionCookie) live in `session-cookie.ts`.
 */

export const SESSION_COOKIE = "rt_portal";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
/** Dev fallback secret. Managed/prod MUST set PORTAL_SESSION_SECRET. */
const DEV_SECRET = "resolvetrace-dev-portal-secret-change-me";

export interface PortalTenantRef {
  id: string;
  displayName: string;
}

/** Full portal session (sealed in the encrypted cookie). */
export interface PortalSession {
  sub: string;
  email: string;
  roles: string[];
  tenants: PortalTenantRef[];
  currentTenantId: string;
  /** Current tenant's role (UI label). */
  role: string;
  /** Current tenant's scopes (UI gating). */
  scopes: string[];
  /** Backend identity token for tenant-select (managed). Secret. */
  identityToken?: string;
  /** Per-tenant data-plane bearer (managed). Secret — never sent to browser. */
  ingestBearer?: string;
  /** Expiry (epoch ms) of the per-tenant bearer, when minted. */
  ingestBearerExp?: number;
  /** Absolute session expiry (epoch ms). */
  exp: number;
}

/** Non-secret view safe to hand to client components. */
export interface PortalSessionView {
  sub: string;
  email: string;
  roles: string[];
  tenants: PortalTenantRef[];
  currentTenantId: string;
  role: string;
  scopes: string[];
}

/** Strip the secret fields for handing to the browser / client components. */
export function publicView(s: PortalSession): PortalSessionView {
  return {
    sub: s.sub,
    email: s.email,
    roles: s.roles,
    tenants: s.tenants,
    currentTenantId: s.currentTenantId,
    role: s.role,
    scopes: s.scopes,
  };
}

/** Wrap a login/select result in a session envelope with an expiry stamp. */
export function buildSession(
  input: Omit<PortalSession, "exp">,
  nowMs: number = Date.now()
): PortalSession {
  return { ...input, exp: nowMs + SESSION_TTL_MS };
}

// --- crypto (Web Crypto; isomorphic Edge + Node) ---------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(): Promise<CryptoKey> {
  const secret = process.env.PORTAL_SESSION_SECRET || DEV_SECRET;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypt + serialize a session into a cookie-safe string. */
export async function sealSession(session: PortalSession): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64urlEncode(packed);
}

/**
 * Decrypt + validate a session cookie value. Returns `null` on any failure
 * (tampering, wrong key, malformed, or expired) so callers treat it as
 * "not authenticated".
 */
export async function openSession(value: string): Promise<PortalSession | null> {
  try {
    const packed = b64urlDecode(value);
    if (packed.length < 13) return null;
    const iv = packed.slice(0, 12);
    const ct = packed.slice(12);
    const key = await aesKey();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const session = JSON.parse(
      new TextDecoder().decode(new Uint8Array(pt))
    ) as PortalSession;
    if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}
