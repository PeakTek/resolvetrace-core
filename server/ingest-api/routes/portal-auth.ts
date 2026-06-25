/**
 * Portal authentication routes.
 *
 * `POST /api/v1/portal/auth/login` verifies a username + password against the
 * configured `AuthProvider` (local or OIDC-password). It is called by the
 * portal server-to-server, so the request still carries the portal bearer
 * (authenticated by the auth plugin) — the bearer identifies the tenant, the
 * body carries the user credentials being verified.
 *
 * On success it returns the principal's roles (admin/viewer) so the portal can
 * gate admin-only surfaces, and writes an `auth.login` audit record. On
 * failure it returns 401 and writes an `auth.login_failed` record. The audit
 * actor is the username being authenticated; the password is NEVER logged.
 */

import { FastifyPluginAsync } from "fastify";
import { AuditSink } from "../types.js";
import { AuditAction, recordAudit } from "../audit.js";
import type { AuthProvider } from "../../auth/index.js";

export interface PortalAuthRoutesOptions {
  authProvider: AuthProvider;
  auditSink: AuditSink;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}

export const portalAuthRoutes: FastifyPluginAsync<
  PortalAuthRoutesOptions
> = async (fastify, opts) => {
  fastify.post(
    "/api/v1/portal/auth/login",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }

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

      const result = await opts.authProvider.verifyCredentials({
        username,
        password,
      });

      if (!result) {
        // Record the failed attempt. Actor is the attempted username; we never
        // log the password.
        await recordAudit(
          opts.auditSink,
          principal.config.tenantId,
          {
            actor: username,
            action: AuditAction.AUTH_LOGIN_FAILED,
            metadata: { method: "password" },
          },
          request.log
        );
        reply.code(401);
        return {
          error: "unauthorized",
          message: "Invalid username or password.",
        };
      }

      await recordAudit(
        opts.auditSink,
        principal.config.tenantId,
        {
          actor: result.userId,
          action: AuditAction.AUTH_LOGIN,
          metadata: { method: "password" },
        },
        request.log
      );

      return {
        user: {
          userId: result.userId,
          email: result.email,
          roles: result.roles,
        },
      };
    }
  );
};
