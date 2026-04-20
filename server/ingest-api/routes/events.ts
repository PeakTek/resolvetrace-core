/**
 * POST /v1/events — batch event ingest.
 *
 * Flow:
 *  1. Auth plugin has already resolved the principal (tenant + env).
 *  2. Body-validator ensures the payload matches `EventBatchRequest`.
 *  3. For each envelope, reserve `(tenantId, eventId)` in the idempotency
 *     store. First-seen entries are forwarded to the event sink; duplicate
 *     entries are counted and dropped.
 *  4. Respond 202 with `EventBatchAcceptedResponse`.
 *
 * The whole request is marked idempotent: if every envelope in the batch
 * was a duplicate, we set `X-Idempotent-Replay: true`.
 *
 * Note: the event sink is an in-memory queue in OSS Wave 4; real durable
 * persistence lands in a later wave. See README.
 */

import { FastifyPluginAsync } from "fastify";
import { EventSink, IdempotencyStore, ValidatedEvent } from "../types.js";

const DEDUP_WINDOW_SECONDS = 24 * 60 * 60; // 24 h, ADR-0011

export interface EventsRoutesOptions {
  eventSink: EventSink;
  idempotencyStore: IdempotencyStore;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}


export const eventsRoutes: FastifyPluginAsync<EventsRoutesOptions> = async (
  fastify,
  opts
) => {
  fastify.post(
    "/v1/events",
    {
      config: {
        rateLimit: opts.rateLimitOptions,
      },
    },
    async (request, reply) => {
      const body = request.validateBody("EventBatchRequest") as {
        events: ValidatedEvent[];
      };
      const principal = request.principal;
      if (!principal) {
        // Auth plugin runs before us; this is a belt-and-braces guard.
        reply.code(401);
        return { error: "unauthorized" };
      }
      const tenantId = principal.config.tenantId;

      let accepted = 0;
      let duplicates = 0;
      const fresh: ValidatedEvent[] = [];
      for (const evt of body.events) {
        const key = `${tenantId}:${evt.eventId}`;
        // eslint-disable-next-line no-await-in-loop
        const reserved = await opts.idempotencyStore.reserve(
          key,
          DEDUP_WINDOW_SECONDS
        );
        if (reserved) {
          accepted += 1;
          fresh.push(evt);
        } else {
          duplicates += 1;
        }
      }

      if (fresh.length > 0) {
        await opts.eventSink.enqueue(tenantId, fresh);
      }

      if (duplicates === body.events.length) {
        reply.header("X-Idempotent-Replay", "true");
      }

      reply.code(202);
      return {
        accepted,
        duplicates,
        receivedAt: new Date().toISOString(),
      };
    }
  );
};
