/**
 * POST /v1/session/start — record a new session.
 * POST /v1/session/end — record a session close.
 *
 * Both endpoints are idempotent. Repeated calls with the same `sessionId`
 * are no-ops on the server and return the original acceptance timestamp.
 * An `end` without a preceding `start` still returns 200 (the server records
 * it and reconciles at query time).
 *
 * Session persistence in OSS Wave 4 is an in-memory map; real durable
 * persistence lands in a later wave.
 */

import { FastifyPluginAsync } from "fastify";
import { SessionSink } from "../types.js";

export interface SessionRoutesOptions {
  sessionSink: SessionSink;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}

export const sessionRoutes: FastifyPluginAsync<SessionRoutesOptions> = async (
  fastify,
  opts
) => {
  fastify.post(
    "/v1/session/start",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const body = request.validateBody("SessionStartRequest") as {
        sessionId: string;
        startedAt: string;
        appVersion?: string;
        releaseChannel?: string;
        client?: unknown;
        userAnonId?: string;
        identify?: {
          userId?: string | null;
          traits?: Record<string, unknown>;
        };
      };

      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized" };
      }

      await opts.sessionSink.recordStart(principal.config.tenantId, {
        sessionId: body.sessionId,
        startedAt: body.startedAt,
        appVersion: body.appVersion,
        releaseChannel: body.releaseChannel,
        client: body.client,
        userAnonId: body.userAnonId,
        identify: body.identify,
      });

      reply.code(201);
      return {
        sessionId: body.sessionId,
        acceptedAt: new Date().toISOString(),
      };
    }
  );

  fastify.post(
    "/v1/session/end",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const body = request.validateBody("SessionEndRequest") as {
        sessionId: string;
        endedAt: string;
        reason: string;
        eventCount?: number;
        replayChunkCount?: number;
      };

      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized" };
      }

      await opts.sessionSink.recordEnd(principal.config.tenantId, {
        sessionId: body.sessionId,
        endedAt: body.endedAt,
        reason: body.reason,
        eventCount: body.eventCount,
        replayChunkCount: body.replayChunkCount,
      });

      reply.code(200);
      return {
        sessionId: body.sessionId,
        acceptedAt: new Date().toISOString(),
      };
    }
  );
};
