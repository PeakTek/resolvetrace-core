/**
 * Generic OIDC auth provider.
 *
 * Works with any RFC-compliant OpenID Connect provider. The OSS server
 * uses this for Keycloak, Auth0, generic OIDC, etc. No provider-specific
 * integrations live here.
 *
 * Flow: Authorization Code + PKCE. `beginOidcFlow()` returns a redirect
 * URL and an opaque state; `completeOidcFlow({code, state})` exchanges
 * the code for tokens, verifies the ID token, and returns a principal.
 *
 * This module depends on the `openid-client` library. The minimal shape
 * needed is typed locally below so the file typechecks even if the
 * package is not yet installed in the toolchain; the runtime code paths
 * use the real library.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  AuthConfigError,
  AuthPrincipal,
  AuthProvider,
  LocalCredentials,
  OidcBeginResult,
  OidcCompleteParams,
} from "./types.js";

/**
 * Minimal interface over the `openid-client` surface we use. Kept narrow
 * on purpose: the production provider wires this to the real library; the
 * test harness passes a mock that implements the same shape.
 */
export interface OidcClientLike {
  authorizationUrl(params: {
    scope: string;
    state: string;
    code_challenge: string;
    code_challenge_method: "S256";
    redirect_uri: string;
  }): string;

  callback(
    redirectUri: string,
    params: { code: string; state: string },
    checks: { state: string; code_verifier: string }
  ): Promise<{
    claims(): {
      sub: string;
      email?: string;
      roles?: string[];
      "https://resolvetrace.example/roles"?: string[];
    };
  }>;
}

export interface OidcAuthOptions {
  client: OidcClientLike;
  redirectUrl: string;
  /** Space-separated scope string (default `openid profile email`). */
  scope?: string;
  /** Default roles assigned when the ID token carries none. */
  defaultRoles?: string[];
}

interface PendingFlow {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

export class OidcAuthProvider implements AuthProvider {
  private readonly client: OidcClientLike;
  private readonly redirectUrl: string;
  private readonly scope: string;
  private readonly defaultRoles: string[];
  private readonly pending = new Map<string, PendingFlow>();

  constructor(opts: OidcAuthOptions) {
    this.client = opts.client;
    this.redirectUrl = opts.redirectUrl;
    this.scope = opts.scope ?? "openid profile email";
    this.defaultRoles = opts.defaultRoles ?? ["viewer"];
  }

  /**
   * OIDC-only provider: password credentials are never accepted here.
   * Returning `null` lets composite providers fall back to another backend
   * if one is configured; see `createAuthProvider` factory.
   */
  async verifyCredentials(
    _input: LocalCredentials
  ): Promise<AuthPrincipal | null> {
    return null;
  }

  async beginOidcFlow(): Promise<OidcBeginResult> {
    const state = randomToken();
    const codeVerifier = randomToken(48);
    const codeChallenge = computeChallengeS256(codeVerifier);

    this.pending.set(state, {
      state,
      codeVerifier,
      // 10 minutes; flows that take longer are rejected.
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    this.pruneExpired();

    const redirectUrl = this.client.authorizationUrl({
      scope: this.scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: this.redirectUrl,
    });

    return { redirectUrl, state };
  }

  async completeOidcFlow(
    params: OidcCompleteParams
  ): Promise<AuthPrincipal> {
    this.pruneExpired();
    const pending = this.pending.get(params.state);
    if (!pending) {
      throw new AuthConfigError("Unknown or expired OIDC state");
    }
    this.pending.delete(params.state);

    const tokenSet = await this.client.callback(
      this.redirectUrl,
      { code: params.code, state: params.state },
      { state: pending.state, code_verifier: pending.codeVerifier }
    );
    const claims = tokenSet.claims();

    const roles =
      claims.roles ??
      claims["https://resolvetrace.example/roles"] ??
      this.defaultRoles;

    return {
      userId: `oidc:${claims.sub}`,
      email: claims.email ?? claims.sub,
      roles: [...roles],
    };
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [state, p] of this.pending) {
      if (p.expiresAt < now) {
        this.pending.delete(state);
      }
    }
  }
}

/**
 * Build an `OidcAuthProvider` from env vars. Expects:
 * `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL`.
 *
 * Actual discovery + client construction uses `openid-client`. This function
 * delegates to a provided discoverer so the test harness does not have to
 * stand up a real IdP.
 */
export async function createOidcAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  discoverer: (opts: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
  }) => Promise<OidcClientLike> = defaultDiscoverer
): Promise<OidcAuthProvider> {
  const issuerUrl = env.OIDC_ISSUER_URL;
  const clientId = env.OIDC_CLIENT_ID;
  const clientSecret = env.OIDC_CLIENT_SECRET;
  const redirectUrl = env.OIDC_REDIRECT_URL;
  if (!issuerUrl || !clientId || !clientSecret || !redirectUrl) {
    throw new AuthConfigError(
      "OIDC auth requires OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URL"
    );
  }
  const client = await discoverer({
    issuerUrl,
    clientId,
    clientSecret,
    redirectUrl,
  });
  return new OidcAuthProvider({
    client,
    redirectUrl,
    scope: env.OIDC_SCOPE,
  });
}

/**
 * Default discoverer wires `openid-client` at runtime. Kept as a tiny
 * lazy-imported adapter so the test harness can inject its own client
 * without touching the network.
 */
async function defaultDiscoverer(opts: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}): Promise<OidcClientLike> {
  // Late dynamic import so tests can run without the dependency installed.
  const mod = (await import("openid-client")) as unknown as {
    Issuer: {
      discover(url: string): Promise<{
        Client: new (cfg: {
          client_id: string;
          client_secret: string;
          redirect_uris: string[];
          response_types: string[];
        }) => OidcClientLike;
      }>;
    };
  };
  const issuer = await mod.Issuer.discover(opts.issuerUrl);
  return new issuer.Client({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uris: [opts.redirectUrl],
    response_types: ["code"],
  });
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function computeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
