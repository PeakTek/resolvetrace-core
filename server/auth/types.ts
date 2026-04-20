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
