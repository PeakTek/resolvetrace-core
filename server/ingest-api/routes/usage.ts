/**
 * Portal usage API (internal, admin-only).
 *
 *   GET /api/v1/portal/usage — this tenant's replay usage for the current UTC
 *   calendar month: distinct sessions that recorded replay + GB-month of stored
 *   replay. Tenant-scoped via the principal's resolved config; requires the
 *   admin scope (`tenant:admin`), like the retention/settings surface.
 *
 * A composing server may inject `usageAnnotations` to attach opaque label/value
 * rows (which the portal renders verbatim); core authors none of them. Not part
 * of the public SDK contract — the `/api/v1/portal/*` prefix marks the internal
 * scope; response shapes may change without SemVer commitment.
 */

import { FastifyPluginAsync } from "fastify";
import type { PortalUsageAnnotations, ReplayManifestStore } from "../types.js";
import type { RetentionConfig } from "../retention-config.js";
import { SCOPE_TENANT_ADMIN } from "../retention.js";
import type { ApiKeyPrincipal } from "../../tenant-resolver/index.js";
import { bytesToGbMonth } from "../usage.js";

export interface UsageRoutesOptions {
  replayManifestStore: ReplayManifestStore;
  retentionConfig: RetentionConfig;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
  /** Optional composing-server annotations (opaque rows). Absent ⇒ counts only. */
  usageAnnotations?: PortalUsageAnnotations;
}

/** `[1st of this month, 1st of next month)` in UTC. */
function currentCalendarMonth(now: Date): {
  periodStart: Date;
  periodEnd: Date;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    periodStart: new Date(Date.UTC(y, m, 1)),
    periodEnd: new Date(Date.UTC(y, m + 1, 1)),
  };
}

export const usageRoutes: FastifyPluginAsync<UsageRoutesOptions> = async (
  fastify,
  opts
) => {
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Portal-Api-Version", "1");
    return payload;
  });

  /** Admin-scope guard: returns the principal, or sends the error + null. */
  function requireAdmin(
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ): ApiKeyPrincipal | null {
    const principal = request.principal;
    if (!principal) {
      reply
        .code(401)
        .send({ error: "unauthorized", message: "Missing principal." });
      return null;
    }
    if (!principal.scopes.includes(SCOPE_TENANT_ADMIN)) {
      reply.code(403).send({
        error: "forbidden",
        message: "This operation requires admin privileges.",
      });
      return null;
    }
    return principal;
  }

  fastify.get(
    "/api/v1/portal/usage",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const tenantId = principal.config.tenantId;
      const { periodStart, periodEnd } = currentCalendarMonth(new Date());
      const { replaySessions, bytes } =
        await opts.replayManifestStore.aggregateUsage(
          tenantId,
          periodStart,
          periodEnd
        );
      const gbMonth = bytesToGbMonth(
        bytes,
        opts.retentionConfig.replayDays,
        periodStart,
        periodEnd
      );
      const annotations = opts.usageAnnotations
        ? await opts.usageAnnotations.get(tenantId, periodStart, periodEnd)
        : null;

      return {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        replaySessions,
        bytes,
        gbMonth,
        annotations,
      };
    }
  );
};
