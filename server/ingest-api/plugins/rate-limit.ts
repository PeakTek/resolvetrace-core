/**
 * Rate-limit plugin.
 *
 * Wraps `@fastify/rate-limit` with per-class quotas keyed on the resolved
 * tenant id. Each class (events, replay signed-url, replay complete,
 * session) has its own soft + hard ceiling. Responses use the
 * `RateLimitErrorResponse` schema published in the contract repo.
 *
 * In OSS single-tenant mode, "per-tenant" effectively means "per-API-key"
 * — a single deployment with one key has the full quota to itself.
 */

import { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import rateLimit, { RateLimitOptions } from "@fastify/rate-limit";
import { RateLimitBudget, RateLimitClass } from "../types.js";

/** Default quotas — documented in the OpenAPI spec / README. */
export const DEFAULT_RATE_LIMITS: Record<RateLimitClass, RateLimitBudget> = {
  events: { soft: 60, hard: 120 },
  replay_signed_url: { soft: 10, hard: 30 },
  replay_complete: { soft: 10, hard: 30 },
  session: { soft: 5, hard: 20 },
};

export interface RateLimitPluginOptionsExt {
  limits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
}

/**
 * Map a class + dimension to a Fastify rate-limit plugin config. We use a
 * 1-second window with `max = hard` so short bursts are clamped, then a
 * per-route hook enforces the per-minute soft ceiling via a sliding counter
 * (inside the plugin's token bucket).
 */
function pluginOptsFor(
  klass: RateLimitClass,
  budget: RateLimitBudget
): RateLimitOptions {
  return {
    max: budget.hard,
    timeWindow: "1 second",
    keyGenerator: (request) => {
      const principal = request.principal;
      const tenantId = principal?.config.tenantId ?? "anonymous";
      return `${klass}:${tenantId}`;
    },
    errorResponseBuilder: (_request, context) => {
      // Mirrors schemas/api-responses.json#/definitions/RateLimitErrorResponse.
      const retryAfter = Math.max(1, Math.ceil(context.ttl / 1000));
      return {
        error: "rate_limit_exceeded",
        retryAfterSeconds: retryAfter,
        class: klass,
        scope: "tenant",
      };
    },
  };
}

/**
 * Register the rate-limit plugin with a configuration that lets per-route
 * handlers opt into their class. We register the plugin globally in "off"
 * mode, then each route activates the policy it needs with a
 * `config.rateLimit` override.
 */
export function buildRateLimitPluginOptions(
  limits: Partial<Record<RateLimitClass, RateLimitBudget>> = {}
): Record<RateLimitClass, RateLimitOptions> {
  const merged = { ...DEFAULT_RATE_LIMITS, ...limits } as Record<
    RateLimitClass,
    RateLimitBudget
  >;
  return {
    events: pluginOptsFor("events", merged.events),
    replay_signed_url: pluginOptsFor(
      "replay_signed_url",
      merged.replay_signed_url
    ),
    replay_complete: pluginOptsFor("replay_complete", merged.replay_complete),
    session: pluginOptsFor("session", merged.session),
  };
}

/** Global registration — `global: false` so each route wires its own policy. */
const rateLimitPluginImpl: FastifyPluginAsync<RateLimitPluginOptionsExt> =
  async (fastify, opts) => {
    const merged = { ...DEFAULT_RATE_LIMITS, ...(opts.limits ?? {}) } as Record<
      RateLimitClass,
      RateLimitBudget
    >;
    await fastify.register(rateLimit, {
      global: false,
      // Ban header name normalisation: Fastify lowercases by default.
      addHeadersOnExceeding: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
      },
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true,
      },
      max: Math.max(
        merged.events.hard,
        merged.replay_signed_url.hard,
        merged.replay_complete.hard,
        merged.session.hard
      ),
      timeWindow: "1 second",
    });
  };

// Wrap with fastify-plugin so the per-route rate-limit config registered via
// `config.rateLimit` on routes in the parent scope finds its plugin instance.
export const rateLimitPlugin = fp(rateLimitPluginImpl, {
  name: "rate-limit",
  fastify: "4.x",
});
