/**
 * Authentication provider abstraction.
 *
 * ResolveTrace OSS supports two auth modes out of the box:
 *
 * - **Local** — single admin user with a bcrypt-hashed password configured
 *   via environment variables. Suitable for a laptop / single-team install.
 * - **OIDC** — any RFC-compliant OpenID Connect provider. Works with
 *   Keycloak, Auth0, Google Workspace, generic IdPs.
 *
 * Additional providers can be plugged in by implementing `AuthProvider`.
 */

/** An authenticated principal (typically a portal user). */
export interface AuthPrincipal {
  userId: string;
  email: string;
  roles: string[];
}

/** Credentials presented by a local (username + password) login. */
export interface LocalCredentials {
  username: string;
  password: string;
}

/** Result of initiating an OIDC redirect. */
export interface OidcBeginResult {
  redirectUrl: string;
  /** Opaque state value the caller is expected to round-trip through the IdP. */
  state: string;
}

/** Parameters returned by the IdP on the redirect back to our server. */
export interface OidcCompleteParams {
  code: string;
  state: string;
  /**
   * RFC 9207 issuer identifier, when the IdP includes it on the redirect.
   * Callers should pass it through verbatim: OIDC clients validate it and may
   * REJECT the response without it when the IdP advertises support.
   */
  iss?: string;
}

/**
 * AuthProvider — the interface every auth backend satisfies.
 *
 * Not every method is meaningful for every provider. OIDC-only providers
 * return `null` from `verifyCredentials`; password-only providers omit the
 * OIDC methods.
 */
export interface AuthProvider {
  /**
   * Verify username + password credentials. Returns the principal on
   * success, `null` on any failure (wrong password, unknown user, or
   * provider doesn't support password auth).
   *
   * Implementations MUST take care to run in roughly constant time to
   * avoid leaking whether a username exists via timing.
   */
  verifyCredentials(input: LocalCredentials): Promise<AuthPrincipal | null>;

  /** Begin an OIDC Authorization Code + PKCE flow. Optional. */
  beginOidcFlow?(): Promise<OidcBeginResult>;

  /** Complete an OIDC Authorization Code + PKCE flow. Optional. */
  completeOidcFlow?(params: OidcCompleteParams): Promise<AuthPrincipal>;
}

/** Raised when auth configuration is missing or malformed. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

// ---------------------------------------------------------------------------
// Portal authorization seams (multi-tenant portal).
//
// These interfaces are IMPLEMENTED by a composing deployment and injected into
// the app builder — the same pattern as `AuthProvider` and the tenant
// resolver. They are deliberately generic: no directory, IdP, or
// role-catalogue specifics. A single-tenant (OSS) deployment injects none of
// them and the portal-auth contract falls back to one synthetic tenant.
//
// Separation of concerns: `AuthProvider` answers *who* the user is (identity);
// `MembershipProvider` answers *what tenants* they belong to and their *role*
// in each (authorization). Roles are NOT put on `AuthPrincipal` so that type
// stays stable across the OSS↔managed boundary.
// ---------------------------------------------------------------------------

/** A tenant reference safe to surface to the portal UI (no secrets). */
export interface PortalTenantRef {
  /** Opaque tenant id (ULID in managed; a synthetic id in OSS). */
  id: string;
  /** Human-readable tenant name for the tenant switcher. */
  displayName: string;
}

/** A user's membership in one tenant: the tenant plus the user's role there. */
export interface PortalTenantMembership {
  tenantId: string;
  displayName: string;
  /**
   * Role name (e.g. `support` / `engineer` / `admin`). Opaque to core — it is
   * a UI label and the input to the deployment's role→scope mapping. Core
   * never branches on the role name for enforcement; it enforces scopes.
   */
  role: string;
}

/**
 * Resolves a portal user to the tenant(s) they may access and their role in
 * each. Managed injects a registry-backed implementation; when absent, the
 * portal-auth contract uses a single synthetic tenant (OSS single-tenant).
 */
export interface MembershipProvider {
  /** All active memberships for the user. Empty ⇒ the user has no tenant. */
  listForUser(userId: string): Promise<PortalTenantMembership[]>;
  /** The user's membership in one tenant, or `null` if they are not a member. */
  resolve(
    userId: string,
    tenantId: string
  ): Promise<PortalTenantMembership | null>;
}

/**
 * A short-lived, per-tenant credential the portal server uses to call the
 * data-plane query API as the user, scoped to their role. Held SERVER-SIDE by
 * the portal — it is never exposed to the browser.
 */
export interface MintedPortalCredential {
  /** The bearer token (an ES256 tenant key in managed). */
  credential: string;
  /** Absolute expiry (epoch ms) so the portal can refresh before it lapses. */
  expiresAt: number;
  /**
   * The scopes granted on this credential (the role's scopes). The portal UI
   * gates on these; the data plane enforces them. Returned so the login/
   * tenant-select response can reflect exactly what the credential permits.
   */
  scopes: string[];
}

/**
 * Mints a per-tenant portal credential for a user's membership. Managed injects
 * an implementation that signs a short-lived tenant key whose scopes are the
 * role's scopes; when absent, the portal uses the deployment's static portal
 * token (OSS single-tenant) and this seam is not called.
 */
export interface TenantCredentialMinter {
  mint(
    userId: string,
    membership: PortalTenantMembership
  ): Promise<MintedPortalCredential>;
}

/** Capability descriptor returned by the portal-auth `config` probe. */
export interface PortalAuthConfig {
  /**
   * `password` — render a username/password form and POST it to the login
   * endpoint. `redirect` — the login is an IdP redirect (hosted UI / SSO).
   */
  mode: "password" | "redirect";
  /** Free-text label for the login affordance (e.g. "Sign in", "SSO"). */
  providerLabel: string;
}
