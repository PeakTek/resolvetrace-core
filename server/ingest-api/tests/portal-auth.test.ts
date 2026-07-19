/**
 * Portal-auth contract tests (identity-first, multi-tenant capable).
 *
 * Exercises the neutral `/api/v1/portal/auth/*` contract with injected
 * membership + minter seams (the managed shape) and without them (the OSS
 * single-tenant fallback). A composing deployment supplies the managed
 * implementations; here we assert core's contract + wiring against in-memory
 * fakes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { OidcAuthProvider } from "../../auth/index.js";
import type {
  AuthProvider,
  MembershipProvider,
  OidcClientLike,
  PortalTenantMembership,
  TenantCredentialMinter,
} from "../../auth/index.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (close) await close();
  close = undefined;
});

const adminAuth: AuthProvider = {
  async verifyCredentials(input) {
    if (input.username === "u@example.test" && input.password === "correct") {
      return { userId: "sub-123", email: "u@example.test", roles: ["member"] };
    }
    return null;
  },
};

/** Membership provider: user sub-123 is admin of t-A and support of t-B. */
class FakeMemberships implements MembershipProvider {
  private readonly rows: Record<string, PortalTenantMembership[]> = {
    "sub-123": [
      { tenantId: "t-A", displayName: "Acme", role: "admin" },
      { tenantId: "t-B", displayName: "Beta", role: "support" },
    ],
  };
  async listForUser(userId: string): Promise<PortalTenantMembership[]> {
    return this.rows[userId] ?? [];
  }
  async resolve(
    userId: string,
    tenantId: string
  ): Promise<PortalTenantMembership | null> {
    return (this.rows[userId] ?? []).find((m) => m.tenantId === tenantId) ?? null;
  }
}

/** Minter: scopes derived from the role (mirrors the platform role→scope map). */
class FakeMinter implements TenantCredentialMinter {
  async mint(userId: string, m: PortalTenantMembership) {
    const scopes =
      m.role === "admin"
        ? ["session:read", "audit:read", "tenant:admin"]
        : ["session:read"];
    return {
      credential: `key-${m.tenantId}-${userId}`,
      expiresAt: 9_999_999_999_000,
      scopes,
    };
  }
}

const SECRET = "test-portal-secret";

async function buildManaged() {
  return buildTestApp({
    authProvider: adminAuth,
    membershipProvider: new FakeMemberships(),
    tenantCredentialMinter: new FakeMinter(),
    portalTokenSecret: SECRET,
  });
}

describe("portal-auth config", () => {
  it("returns the default password-mode capability descriptor", async () => {
    const { app } = await buildTestApp({ authProvider: adminAuth });
    close = () => app.close();
    const res = await app.inject({ method: "GET", url: "/api/v1/portal/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "password", providerLabel: "Sign in" });
  });
});

describe("portal-auth login (managed multi-tenant)", () => {
  it("returns all memberships + scopes + a minted credential for the current tenant", async () => {
    const { app } = await buildManaged();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      payload: { username: "u@example.test", password: "correct" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toEqual({
      userId: "sub-123",
      email: "u@example.test",
      roles: ["member"],
    });
    // Both memberships surfaced for the switcher.
    expect(body.tenants).toEqual([
      { id: "t-A", displayName: "Acme" },
      { id: "t-B", displayName: "Beta" },
    ]);
    // Current tenant = first membership (admin of Acme) → admin scopes.
    expect(body.currentTenantId).toBe("t-A");
    expect(body.role).toBe("admin");
    expect(body.scopes).toEqual(["session:read", "audit:read", "tenant:admin"]);
    // A minted credential is returned to the portal server (held server-side).
    expect(body.ingestCredential.credential).toBe("key-t-A-sub-123");
    expect(typeof body.identityToken).toBe("string");
  });

  it("rejects bad credentials with 401", async () => {
    const { app } = await buildManaged();
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      payload: { username: "u@example.test", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 no_tenants when the user has no memberships", async () => {
    const noTenantAuth: AuthProvider = {
      async verifyCredentials() {
        return { userId: "stranger", email: "s@x.test", roles: ["member"] };
      },
    };
    const { app } = await buildTestApp({
      authProvider: noTenantAuth,
      membershipProvider: new FakeMemberships(),
      tenantCredentialMinter: new FakeMinter(),
      portalTokenSecret: SECRET,
    });
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      payload: { username: "whatever", password: "whatever" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("no_tenants");
  });
});

describe("portal-auth tenant-select (managed multi-tenant)", () => {
  async function loginAndGetToken(app: Awaited<ReturnType<typeof buildManaged>>["app"]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      payload: { username: "u@example.test", password: "correct" },
    });
    return res.json().identityToken as string;
  }

  it("mints a support-scoped credential when switching to a support-role tenant", async () => {
    const { app } = await buildManaged();
    close = () => app.close();
    const token = await loginAndGetToken(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/tenant-select",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-B" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentTenantId).toBe("t-B");
    expect(body.role).toBe("support");
    // Support role → read-only scope; no tenant:admin.
    expect(body.scopes).toEqual(["session:read"]);
    expect(body.ingestCredential.credential).toBe("key-t-B-sub-123");
  });

  it("returns 401 without a valid identity token", async () => {
    const { app } = await buildManaged();
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/tenant-select",
      payload: { tenantId: "t-B" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when selecting a tenant the user is not a member of", async () => {
    const { app } = await buildManaged();
    close = () => app.close();
    const token = await loginAndGetToken(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/tenant-select",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantId: "t-ZZZ" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("portal-auth login (OSS single-tenant fallback)", () => {
  it("returns one synthetic tenant with the user's role and no minted credential", async () => {
    const { app } = await buildTestApp({
      authProvider: adminAuth,
      defaultPortalTenant: { id: "oss", displayName: "ResolveTrace" },
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      payload: { username: "u@example.test", password: "correct" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenants).toEqual([{ id: "oss", displayName: "ResolveTrace" }]);
    expect(body.currentTenantId).toBe("oss");
    // No minter → scopes come from the neutral default map ("member" → least priv).
    expect(body.scopes).toEqual(["session:read"]);
    // No minter → no server-side credential (portal uses its static token).
    expect(body.ingestCredential).toBeUndefined();
    // No portalTokenSecret → no identity token needed for a single tenant.
    expect(body.identityToken).toBeUndefined();
  });
});

describe("portal-auth OIDC/SSO redirect flow", () => {
  // A mock OIDC client: authorizationUrl echoes the state; callback records its
  // params and returns a fixed identity. The real openid-client is never touched.
  let lastCallbackParams: { code: string; state: string; iss?: string } | undefined;
  let lastAuthorizeRedirectUri: string | undefined;
  let lastExchangeRedirectUri: string | undefined;
  const oidcClient: OidcClientLike = {
    authorizationUrl(params) {
      lastAuthorizeRedirectUri = params.redirect_uri;
      return `https://idp.test/authorize?state=${params.state}&cc=${params.code_challenge}`;
    },
    async callback(redirectUri, params) {
      lastExchangeRedirectUri = redirectUri;
      lastCallbackParams = params;
      return {
        claims: () => ({
          sub: "oidc-user-1",
          email: "sso@example.test",
          roles: ["member"],
        }),
      };
    },
  };

  function buildOidc() {
    const provider = new OidcAuthProvider({
      client: oidcClient,
      redirectUrl: "https://portal.test/api/auth/callback",
      allowedRedirectUrls: ["https://portal-b.test/api/auth/callback"],
    });
    return buildTestApp({
      authProvider: provider,
      defaultPortalTenant: { id: "oss", displayName: "SSO Workspace" },
    });
  }

  it("config reports redirect mode for an OIDC provider", async () => {
    const { app } = await buildOidc();
    close = () => app.close();
    const res = await app.inject({ method: "GET", url: "/api/v1/portal/auth/config" });
    expect(res.json().mode).toBe("redirect");
  });

  it("authorize returns a redirect URL + state; callback with that state logs in", async () => {
    const { app } = await buildOidc();
    close = () => app.close();

    const authz = await app.inject({ method: "GET", url: "/api/v1/portal/auth/authorize" });
    expect(authz.statusCode).toBe(200);
    const { redirectUrl, state } = authz.json();
    expect(redirectUrl).toContain("https://idp.test/authorize");
    expect(typeof state).toBe("string");

    const cb = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/callback",
      payload: { code: "auth-code", state },
    });
    expect(cb.statusCode, cb.body).toBe(200);
    const body = cb.json();
    // OidcAuthProvider namespaces the subject as `oidc:<sub>`.
    expect(body.user.userId).toBe("oidc:oidc-user-1");
    expect(body.tenants).toEqual([{ id: "oss", displayName: "SSO Workspace" }]);
  });

  it("forwards the RFC 9207 iss parameter to the OIDC client verbatim", async () => {
    const { app } = await buildOidc();
    close = () => app.close();
    lastCallbackParams = undefined;

    const authz = await app.inject({ method: "GET", url: "/api/v1/portal/auth/authorize" });
    const { state } = authz.json();
    const cb = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/callback",
      payload: { code: "auth-code", state, iss: "https://idp.test/realms/rt" },
    });

    expect(cb.statusCode, cb.body).toBe(200);
    // Clients validate iss (and may reject the response without it), so it must
    // reach the OIDC client exactly as the IdP sent it.
    expect(lastCallbackParams?.iss).toBe("https://idp.test/realms/rt");
  });

  it("callback with an unknown/expired state is 401", async () => {
    const { app } = await buildOidc();
    close = () => app.close();
    const cb = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/callback",
      payload: { code: "x", state: "never-issued" },
    });
    expect(cb.statusCode).toBe(401);
  });

  it("honors an allowlisted ?redirect_uri= for the whole flow (multi-host)", async () => {
    const { app } = await buildOidc();
    close = () => app.close();
    lastAuthorizeRedirectUri = undefined;
    lastExchangeRedirectUri = undefined;

    const other = "https://portal-b.test/api/auth/callback";
    const authz = await app.inject({
      method: "GET",
      url: `/api/v1/portal/auth/authorize?redirect_uri=${encodeURIComponent(other)}`,
    });
    expect(authz.statusCode, authz.body).toBe(200);
    expect(lastAuthorizeRedirectUri).toBe(other);

    const cb = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/callback",
      payload: { code: "auth-code", state: authz.json().state },
    });
    expect(cb.statusCode, cb.body).toBe(200);
    // The token exchange reuses the flow's redirect URI, not the default.
    expect(lastExchangeRedirectUri).toBe(other);
  });

  it("rejects a non-allowlisted ?redirect_uri= with 400", async () => {
    const { app } = await buildOidc();
    close = () => app.close();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/auth/authorize?redirect_uri=https%3A%2F%2Fevil.test%2Fcb",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("redirect_uri_not_allowed");
  });

  it("password-mode provider 404s the OIDC endpoints", async () => {
    const passwordAuth: AuthProvider = {
      async verifyCredentials() {
        return null;
      },
    };
    const { app } = await buildTestApp({ authProvider: passwordAuth });
    close = () => app.close();
    const authz = await app.inject({ method: "GET", url: "/api/v1/portal/auth/authorize" });
    expect(authz.statusCode).toBe(404);
  });
});
