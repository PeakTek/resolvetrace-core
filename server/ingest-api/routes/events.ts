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
import { ValidationError } from "../plugins/body-validate.js";
import {
  AuditSink,
  EventSink,
  IdempotencyStore,
  SessionRequiredError,
  SessionUnknownError,
  SettingsRepository,
  ValidatedEvent,
} from "../types.js";
import {
  PRINCIPAL_PORTAL_SERVICE,
} from "../audit.js";
import {
  dispatchReportWebhook,
  FetchWebhookHttpClient,
  type WebhookDispatchPolicy,
  type WebhookHttpClient,
} from "../webhook-dispatch.js";

const DEDUP_WINDOW_SECONDS = 24 * 60 * 60; // 24 h, ADR-0011

/**
 * Event type that triggers a webhook dispatch to the tenant's configured
 * ticketing webhook (in-app problem reporting, feature #5).
 */
const REPORT_EVENT_TYPE = "support.report_submitted";

/**
 * Highest event-schema major this server understands. The wire schema only
 * pins `schemaVersion >= 1`; rejecting *unsupported* majors is a consumer
 * responsibility (doc 18 `backend_must_reject_unsupported_versions`), enforced
 * here so a producer stamping a future major fails loudly rather than having
 * its newer-shaped envelope silently misread.
 */
const SUPPORTED_SCHEMA_MAJOR = 1;

export interface EventsRoutesOptions {
  eventSink: EventSink;
  idempotencyStore: IdempotencyStore;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
  /** Settings store — used to resolve the tenant webhook config on report events. */
  settingsRepository: SettingsRepository;
  /** Audit sink — `webhook.dispatch` outcomes are recorded here. */
  auditSink: AuditSink;
  /**
   * HTTP client the webhook dispatcher uses. Defaults to a `fetch`-backed
   * client with an abort timeout; tests inject a captured-request double.
   */
  webhookHttpClient?: WebhookHttpClient;
  /** Optional retry/backoff/timeout overrides for webhook dispatch. */
  webhookDispatchPolicy?: Partial<WebhookDispatchPolicy>;
}


export const eventsRoutes: FastifyPluginAsync<EventsRoutesOptions> = async (
  fastify,
  opts
) => {
  // Shared webhook HTTP client (default: fetch + abort-timeout). Built once per
  // plugin registration; tests inject a captured-request double.
  const webhookHttpClient =
    opts.webhookHttpClient ?? new FetchWebhookHttpClient();

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

      // Version negotiation: the wire schema guarantees schemaVersion is a
      // present integer >= 1, but only major 1 is understood today. Reject any
      // other major with a clear validation error (400) so a future-major
      // producer is told to upgrade the server rather than silently dropped.
      const unsupported = body.events.find(
        (e) => e.schemaVersion !== SUPPORTED_SCHEMA_MAJOR
      );
      if (unsupported) {
        throw new ValidationError(
          `Unsupported event schemaVersion ${unsupported.schemaVersion}; this server supports major ${SUPPORTED_SCHEMA_MAJOR}.`,
          [
            {
              instancePath: "/events/schemaVersion",
              message: `unsupported schema major (server supports ${SUPPORTED_SCHEMA_MAJOR})`,
              params: {
                received: unsupported.schemaVersion,
                supported: SUPPORTED_SCHEMA_MAJOR,
              },
            },
          ]
        );
      }

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
      const freshKeys: string[] = [];
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
          freshKeys.push(key);
        } else {
          duplicates += 1;
        }
      }

      if (fresh.length > 0) {
        try {
          await opts.eventSink.enqueue(tenantId, fresh);
        } catch (err) {
          // The batch was rejected before persistence. Release the
          // idempotency reservations we just took so the SDK's retry — which
          // ships the same eventIds — is not falsely counted as duplicates.
          if (
            err instanceof SessionUnknownError ||
            err instanceof SessionRequiredError
          ) {
            const release = opts.idempotencyStore.release;
            if (release) {
              for (const k of freshKeys) {
                // eslint-disable-next-line no-await-in-loop
                await release.call(opts.idempotencyStore, k);
              }
            }
          }
          if (err instanceof SessionUnknownError) {
            reply.code(409);
            return {
              error: "session_unknown",
              unresolved_session_ids: err.unresolvedSessionIds,
              message:
                "Unknown session(s) for this tenant. Issue POST /v1/session/start with these session_id values and retry the batch.",
            };
          }
          if (err instanceof SessionRequiredError) {
            reply.code(400);
            return {
              error: "session_required",
              message: "session_id is required on every event in strict mode.",
            };
          }
          throw err;
        }
      }

      // In-app problem reporting (feature #5): for each freshly-ingested
      // `support.report_submitted` event, forward the (already-scrubbed) report
      // to the tenant's configured webhook. This is fire-and-forget — the call
      // returns immediately and any delivery work runs after the response. It
      // never blocks or breaks ingest: a disabled/unconfigured webhook is a
      // no-op, and the dispatcher swallows all delivery errors (recording each
      // outcome as a `webhook.dispatch` audit row). Dedup already happened above,
      // so a report is dispatched at most once per (tenant, eventId).
      const reportEvents = fresh.filter((e) => e.type === REPORT_EVENT_TYPE);
      for (const reportEvent of reportEvents) {
        dispatchReportWebhook(
          {
            settingsRepository: opts.settingsRepository,
            auditSink: opts.auditSink,
            httpClient: webhookHttpClient,
            policy: opts.webhookDispatchPolicy,
            logger: request.log,
          },
          tenantId,
          principal.env,
          // The ingest principal is an API key (the SDK's). Attribute the
          // dispatch to the stable service label; never the secret/raw key.
          principal.jti
            ? `${PRINCIPAL_PORTAL_SERVICE}:${principal.jti}`
            : PRINCIPAL_PORTAL_SERVICE,
          reportEvent
        );
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
