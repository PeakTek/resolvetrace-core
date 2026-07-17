/**
 * Portal authentication routes (identity-first, multi-tenant capable).
 *
 * The portal server calls these server-to-server on behalf of the browser.
 * Unlike the data-plane routes, they do NOT require a tenant bearer — login is
 * identity-first (the user authenticates before any tenant is chosen), so these
 * paths are on the auth plugin's `skipPaths`. Identity across the
 * login→tenant-select hop is carried by a short-lived HMAC identity token
 * (`portal-identity.ts`), verified here; the subject is read from the verified
 * token, never from the request body (anti-spoof).
 *
 * Contract (all under `/api/v1/portal/auth`):
 *   - `GET  config`         → { mode, providerLabel }        (capability probe)
 *   - `POST login`          → { user, tenants[], currentTenantId, role, scopes,
 *                               identityToken?, ingestCredential? }
 *   - `POST tenant-select`  → { currentTenantId, role, scopes, ingestCredential? }
 *   - `GET  session`        → { user, tenants[] }            (revalidate)
 *   - `POST logout`         → 204
 *
 * Managed injects `membershipProvider` (user→tenants+role),
 * `tenantCredentialMinter` (role→scoped short-lived tenant key), and
 * `portalTokenSecret`. When none are injected (OSS single-tenant), the contract
 * resolves to one synthetic tenant with the user's own role and the deployment
 * uses its static portal token for the data plane.
 *
 * `ingestCredential` is a SECRET held server-side by the portal — it is never
 * forwarded to the browser.
 */

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AuditSink } from "../types.js";
import { AuditAction, recordAudit } from "../audit.js";
import type {
  AuthProvider,
  MembershipProvider,
  TenantCredentialMinter,
  PortalTenantMembership,
  PortalAuthConfig,
} from "../../auth/index.js";
import {
  signPortalIdentity,
  verifyPortalIdentity,
  defaultScopesForRole,
} from "../../auth/index.js";

/** Portal identity-token lifetime (also the effective portal session length). */
const IDENTITY_TTL_SECONDS = 60 * 60 * 8; // 8h

export interface PortalAuthRoutesOptions {
  authProvider: AuthProvider;
  auditSink: AuditSink;
  /** Managed: resolves a user to tenants + role. Absent ⇒ single synthetic tenant. */
  membershipProvider?: MembershipProvider;
  /** Managed: mints a per-tenant, role-scoped credential. Absent ⇒ static portal token. */
  tenantCredentialMinter?: TenantCredentialMinter;
  /** HMAC secret for the identity token. Required for multi-tenant tenant-select. */
  portalTokenSecret?: string;
  /** OSS single-tenant descriptor surfaced when no membershipProvider is injected. */
  defaultPortalTenant?: { id: string; displayName: string };
  /** Capability descriptor for the `config` probe. Defaults to password mode. */
  portalAuthConfig?: PortalAuthConfig;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}

export const portalAuthRoutes: FastifyPluginAsync<
  PortalAuthRoutesOptions
> = async (fastify, opts) => {
  const rl = { config: { rateLimit: opts.rateLimitOptions } };
  // Tenant used to record pre-tenant events (a failed login has no chosen
  // tenant). In OSS this is the single tenant; in managed it is a sentinel.
  const auditTenantForAnon = opts.defaultPortalTenant?.id ?? "portal";
  // Multi-tenant mode is active when identity must be proven across the hop.
  const multiTenant = Boolean(opts.membershipProvider || opts.portalTokenSecret);

  /** Memberships for a user: injected provider, else one synthetic tenant. */
  async function membershipsForUser(
    userId: string,
    roles: string[]
  ): Promise<PortalTenantMembership[]> {
    if (opts.membershipProvider) {
      return opts.membershipProvider.listForUser(userId);
    }
    const t = opts.defaultPortalTenant ?? { id: "default", displayName: "Default" };
    return [{ tenantId: t.id, displayName: t.displayName, role: roles[0] ?? "admin" }];
  }

  /** One membership: injected provider, else the synthetic single tenant. */
  async function resolveMembership(
    userId: string,
    roles: string[],
    tenantId: string
  ): Promise<PortalTenantMembership | null> {
    if (opts.membershipProvider) {
      return opts.membershipProvider.resolve(userId, tenantId);
    }
    const t = opts.defaultPortalTenant ?? { id: "default", displayName: "Default" };
    if (tenantId !== t.id) return null;
    return { tenantId: t.id, displayName: t.displayName, role: roles[0] ?? "admin" };
  }

  /** Scopes + (managed) the minted per-tenant credential for a membership. */
  async function scopesAndCredential(
    userId: string,
    m: PortalTenantMembership
  ): Promise<{
    scopes: string[];
    ingestCredential?: { credential: string; expiresAt: number };
  }> {
    if (opts.tenantCredentialMinter) {
      const minted = await opts.tenantCredentialMinter.mint(userId, m);
      return {
        scopes: minted.scopes,
        ingestCredential: {
          credential: minted.credential,
          expiresAt: minted.expiresAt,
        },
      };
    }
    return { scopes: defaultScopesForRole(m.role) };
  }

  /** Verified identity from the Bearer identity token, or null. */
  function identityFrom(
    request: FastifyRequest
  ): { sub: string; email: string; roles: string[] } | null {
    if (!opts.portalTokenSecret) return null;
    const header = request.headers.authorization;
    if (typeof header !== "string") return null;
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !m[1]) return null;
    return verifyPortalIdentity(opts.portalTokenSecret, m[1].trim());
  }

  /**
   * Turn a verified identity principal into the portal login result (tenants +
   * current tenant + scopes + identity token + minted credential), or a 403
   * no_tenants outcome. Shared by password login and the OIDC/SSO callback.
   */
  async function completeLogin(
    principal: { userId: string; email: string; roles: string[] },
    request: FastifyRequest,
    method: string
  ): Promise<
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; status: number; body: Record<string, unknown> }
  > {
    const memberships = await membershipsForUser(principal.userId, principal.roles);
    if (memberships.length === 0) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "no_tenants",
          message: "This account is not a member of any tenant.",
        },
      };
    }
    const current = memberships[0]!;
    const { scopes, ingestCredential } = await scopesAndCredential(
      principal.userId,
      current
    );
    await recordAudit(
      opts.auditSink,
      current.tenantId,
      { actor: principal.userId, action: AuditAction.AUTH_LOGIN, metadata: { method } },
      request.log
    );
    const identityToken = opts.portalTokenSecret
      ? signPortalIdentity(
          opts.portalTokenSecret,
          { sub: principal.userId, email: principal.email, roles: principal.roles },
          IDENTITY_TTL_SECONDS
        )
      : undefined;
    return {
      ok: true,
      result: {
        user: {
          userId: principal.userId,
          email: principal.email,
          roles: principal.roles,
        },
        tenants: memberships.map((m) => ({
          id: m.tenantId,
          displayName: m.displayName,
        })),
        currentTenantId: current.tenantId,
        role: current.role,
        scopes,
        ...(identityToken ? { identityToken } : {}),
        ...(ingestCredential ? { ingestCredential } : {}),
      },
    };
  }

  // --- GET config ---------------------------------------------------------
  // Auto-detect: a provider that supports the OIDC flow ⇒ redirect (SSO) mode;
  // otherwise a username/password form. A composition can override entirely
  // via `portalAuthConfig`.
  fastify.get("/api/v1/portal/auth/config", rl, async () => {
    if (opts.portalAuthConfig) return opts.portalAuthConfig;
    const isOidc = typeof opts.authProvider.beginOidcFlow === "function";
    return isOidc
      ? { mode: "redirect", providerLabel: "Sign in with SSO" }
      : { mode: "password", providerLabel: "Sign in" };
  });

  // --- POST login (identity-first) ---------------------------------------
  fastify.post("/api/v1/portal/auth/login", rl, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const username = body["username"];
    const password = body["password"];
    if (typeof username !== "string" || typeof password !== "string") {
      reply.code(400);
      return {
        error: "invalid_request",
        message: "`username` and `password` are required.",
      };
    }

    const principal = await opts.authProvider.verifyCredentials({
      username,
      password,
    });
    if (!principal) {
      // Actor is the attempted username; the password is NEVER logged.
      await recordAudit(
        opts.auditSink,
        auditTenantForAnon,
        {
          actor: username,
          action: AuditAction.AUTH_LOGIN_FAILED,
          metadata: { method: "password" },
        },
        request.log
      );
      reply.code(401);
      return { error: "unauthorized", message: "Invalid username or password." };
    }

    const outcome = await completeLogin(principal, request, "password");
    if (!outcome.ok) {
      reply.code(outcome.status);
      return outcome.body;
    }
    return outcome.result;
  });

  // --- GET authorize (OIDC/SSO redirect mode) ----------------------------
  // Begins the Authorization Code + PKCE flow; the caller redirects the browser
  // to `redirectUrl`. 404 when the provider is not a redirect/OIDC one.
  fastify.get("/api/v1/portal/auth/authorize", rl, async (_request, reply) => {
    if (typeof opts.authProvider.beginOidcFlow !== "function") {
      reply.code(404);
      return {
        error: "not_supported",
        message: "This deployment does not use redirect login.",
      };
    }
    const begun = await opts.authProvider.beginOidcFlow();
    return { redirectUrl: begun.redirectUrl, state: begun.state };
  });

  // --- POST callback (OIDC/SSO return leg) -------------------------------
  // The portal forwards the `{code, state}` the IdP handed back; we exchange
  // them for an identity and complete login exactly like the password path.
  fastify.post("/api/v1/portal/auth/callback", rl, async (request, reply) => {
    if (typeof opts.authProvider.completeOidcFlow !== "function") {
      reply.code(404);
      return { error: "not_supported" };
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = body["code"];
    const state = body["state"];
    if (typeof code !== "string" || typeof state !== "string") {
      reply.code(400);
      return { error: "invalid_request", message: "`code` and `state` are required." };
    }
    let principal;
    try {
      principal = await opts.authProvider.completeOidcFlow({ code, state });
    } catch {
      await recordAudit(
        opts.auditSink,
        auditTenantForAnon,
        { actor: "oidc", action: AuditAction.AUTH_LOGIN_FAILED, metadata: { method: "oidc" } },
        request.log
      );
      reply.code(401);
      return { error: "unauthorized", message: "SSO sign-in failed." };
    }
    const outcome = await completeLogin(principal, request, "oidc");
    if (!outcome.ok) {
      reply.code(outcome.status);
      return outcome.body;
    }
    return outcome.result;
  });

  // --- POST tenant-select ------------------------------------------------
  fastify.post("/api/v1/portal/auth/tenant-select", rl, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const tenantId = body["tenantId"];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      reply.code(400);
      return { error: "invalid_request", message: "`tenantId` is required." };
    }

    const identity = identityFrom(request);
    if (!identity && multiTenant) {
      reply.code(401);
      return {
        error: "unauthorized",
        message: "Missing or invalid portal session.",
      };
    }
    // OSS single-tenant: no identity token in play; the local admin is implied.
    const userId = identity?.sub ?? "local";
    const roles = identity?.roles ?? ["admin"];

    const membership = await resolveMembership(userId, roles, tenantId);
    if (!membership) {
      reply.code(403);
      return { error: "forbidden", message: "Not a member of this tenant." };
    }
    const { scopes, ingestCredential } = await scopesAndCredential(
      userId,
      membership
    );
    return {
      currentTenantId: membership.tenantId,
      role: membership.role,
      scopes,
      ...(ingestCredential ? { ingestCredential } : {}),
    };
  });

  // --- GET session (revalidate identity + memberships) -------------------
  fastify.get("/api/v1/portal/auth/session", rl, async (request, reply) => {
    const identity = identityFrom(request);
    if (!identity && multiTenant) {
      reply.code(401);
      return { error: "unauthorized", message: "Missing or invalid portal session." };
    }
    const userId = identity?.sub ?? "local";
    const roles = identity?.roles ?? ["admin"];
    const email = identity?.email ?? "";

    const memberships = await membershipsForUser(userId, roles);
    if (memberships.length === 0) {
      reply.code(403);
      return { error: "no_tenants", message: "This account is not a member of any tenant." };
    }
    return {
      user: { userId, email, roles },
      tenants: memberships.map((m) => ({
        id: m.tenantId,
        displayName: m.displayName,
      })),
    };
  });

  // --- POST logout (stateless; the portal clears its own cookie) ---------
  fastify.post(
    "/api/v1/portal/auth/logout",
    rl,
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.code(204);
      return null;
    }
  );
};
