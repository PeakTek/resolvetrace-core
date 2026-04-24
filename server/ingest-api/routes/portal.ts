/**
 * Portal query API (internal).
 *
 * These endpoints back the self-hosted portal's sessions pages. They are
 * NOT part of the public SDK contract in `resolvetrace-contract` — the
 * prefix is `/api/v1/portal/*` to make the internal scope obvious, and
 * the response shapes may change without SemVer commitment.
 *
 * Auth is the same bearer-token flow as the SDK routes; the resolver
 * accepts either `OSS_API_KEY` or `PORTAL_API_TOKEN` in OSS single-tenant
 * mode.
 */

import { FastifyPluginAsync } from "fastify";
import { EventRepository, SessionRepository } from "../types.js";

export interface PortalRoutesOptions {
  sessionRepository: SessionRepository;
  eventRepository: EventRepository;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}

/** Clamps to `[1, max]` with the given default when unspecified or non-numeric. */
function parseLimit(
  raw: unknown,
  defaultValue: number,
  max: number
): number | { error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return defaultValue;
  }
  if (typeof raw !== "string") {
    return { error: "`limit` must be a positive integer." };
  }
  if (!/^[0-9]+$/.test(raw)) {
    return { error: "`limit` must be a positive integer." };
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: "`limit` must be a positive integer." };
  }
  return Math.min(parsed, max);
}

/**
 * The cursor is produced by the repository and is passed back to it
 * verbatim. We only sanity-check that it's a short-ish string of safe
 * characters before handing it off. Repository-level rejection (malformed
 * base64, unparseable JSON) returns an empty page, which is fine.
 */
function validateCursor(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw !== "string") {
    return { error: "`cursor` must be a string." };
  }
  if (raw.length > 512) {
    return { error: "`cursor` exceeds maximum length." };
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    return { error: "`cursor` contains unsupported characters." };
  }
  return raw;
}

export const portalRoutes: FastifyPluginAsync<PortalRoutesOptions> = async (
  fastify,
  opts
) => {
  // Stamp every portal response with a small version marker so downstream
  // consumers can sanity-check they hit the right surface. Scoped to this
  // plugin so SDK routes aren't affected.
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Portal-Api-Version", "1");
    return payload;
  });

  fastify.get(
    "/api/v1/portal/sessions",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }

      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = parseLimit(query["limit"], 50, 200);
      if (typeof limit === "object") {
        reply.code(400);
        return { error: "invalid_request", message: limit.error };
      }
      const cursor = validateCursor(query["cursor"]);
      if (typeof cursor === "object") {
        reply.code(400);
        return { error: "invalid_request", message: cursor.error };
      }

      const page = await opts.sessionRepository.list(
        principal.config.tenantId,
        { limit, cursor }
      );

      return {
        sessions: page.sessions.map((s) => ({
          sessionId: s.sessionId,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          eventCount: s.eventCount,
          appVersion: s.appVersion,
          releaseChannel: s.releaseChannel,
        })),
        nextCursor: page.nextCursor ?? null,
      };
    }
  );

  fastify.get(
    "/api/v1/portal/sessions/:sessionId",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }

      const { sessionId } = request.params as { sessionId: string };
      const query = (request.query ?? {}) as Record<string, unknown>;
      const limit = parseLimit(query["limit"], 200, 1000);
      if (typeof limit === "object") {
        reply.code(400);
        return { error: "invalid_request", message: limit.error };
      }
      const cursor = validateCursor(query["cursor"]);
      if (typeof cursor === "object") {
        reply.code(400);
        return { error: "invalid_request", message: cursor.error };
      }

      const session = await opts.sessionRepository.get(
        principal.config.tenantId,
        sessionId
      );
      if (!session) {
        reply.code(404);
        return {
          error: "not_found",
          message: `No session with id ${sessionId}`,
        };
      }

      const eventsPage = await opts.eventRepository.listBySession(
        principal.config.tenantId,
        sessionId,
        { limit, cursor }
      );

      return {
        session: {
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          endedReason: session.endedReason,
          appVersion: session.appVersion,
          releaseChannel: session.releaseChannel,
          userAnonId: session.userAnonId,
          client: session.client,
          eventCount: session.eventCount,
          replayChunkCount: session.replayChunkCount,
        },
        events: eventsPage.events.map((e) => ({
          eventId: e.eventId,
          type: e.type,
          capturedAt: e.capturedAt,
          attributes: e.attributes,
        })),
        eventsNextCursor: eventsPage.nextCursor ?? null,
      };
    }
  );
};
