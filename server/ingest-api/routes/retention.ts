/**
 * Portal retention + deletion API (internal, admin-only).
 *
 *   GET    /api/v1/portal/settings/retention  — read effective windows.
 *   PUT    /api/v1/portal/settings/retention  — update windows (persisted).
 *   POST   /api/v1/portal/retention/purge     — run an on-demand purge.
 *   DELETE /api/v1/portal/sessions/:sessionId — targeted erasure (Law-25).
 *
 * All four require the admin scope (`audit:read`, reusing the existing RBAC
 * seam); a viewer principal gets 403. Tenant-scoped via the principal's
 * resolved config. Mutations write audit records via A1's non-fatal writer:
 * `settings.update`, `retention.purge`, and `session.delete` respectively.
 *
 * Not part of the public SDK contract — the `/api/v1/portal/*` prefix marks
 * the internal scope; response shapes may change without SemVer commitment.
 */

import { FastifyPluginAsync } from "fastify";
import type { ObjectStorage } from "../../storage/index.js";
import type {
  AuditSink,
  PurgeStore,
  SettingsRepository,
} from "../types.js";
import type { RetentionConfig } from "../retention-config.js";
import {
  PRINCIPAL_PORTAL_SERVICE,
  AuditAction,
  recordAudit,
} from "../audit.js";
import {
  deleteSessionCascade,
  resolveRetentionWindows,
  runPurge,
  SCOPE_RETENTION_ADMIN,
  SETTING_RETENTION_EVENTS_DAYS,
  SETTING_RETENTION_REPLAY_DAYS,
  SETTING_RETENTION_SESSIONS_DAYS,
} from "../retention.js";
import {
  REPLAY_DEFAULTS,
  resolveReplaySettings,
  SETTING_REPLAY_ENABLED,
  SETTING_REPLAY_MODE,
  SETTING_REPLAY_ROUTE_DENY_LIST,
  SETTING_REPLAY_SAMPLE_RATE,
} from "../replay-settings.js";
import {
  isHttpsUrl,
  resolveWebhookConfig,
  SETTING_WEBHOOK_ENABLED,
  SETTING_WEBHOOK_SECRET,
  SETTING_WEBHOOK_URL,
  toWebhookSettingsView,
  WEBHOOK_DEFAULTS,
} from "../webhook-settings.js";
import {
  deliverWebhook,
  FetchWebhookHttpClient,
  type WebhookDispatchPolicy,
  type WebhookHttpClient,
  type WebhookReportPayload,
} from "../webhook-dispatch.js";
import type { ApiKeyPrincipal } from "../../tenant-resolver/index.js";

export interface RetentionRoutesOptions {
  purgeStore: PurgeStore;
  storage: ObjectStorage;
  settingsRepository: SettingsRepository;
  auditSink: AuditSink;
  retentionConfig: RetentionConfig;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
  /** HTTP client for the "send test webhook" action. Defaults to fetch. */
  webhookHttpClient?: WebhookHttpClient;
  /** Optional retry/backoff/timeout overrides for the test dispatch. */
  webhookDispatchPolicy?: Partial<WebhookDispatchPolicy>;
}

/** Same actor derivation as the portal read routes — never logs the secret. */
function actorFor(principal: ApiKeyPrincipal): string {
  return principal.jti
    ? `${PRINCIPAL_PORTAL_SERVICE}:${principal.jti}`
    : PRINCIPAL_PORTAL_SERVICE;
}

/** Maps a settings key to the request-body field that updates it. */
const FIELD_TO_SETTING: Record<string, string> = {
  eventsDays: SETTING_RETENTION_EVENTS_DAYS,
  sessionsDays: SETTING_RETENTION_SESSIONS_DAYS,
  replayDays: SETTING_RETENTION_REPLAY_DAYS,
};

/** Validate a day-window field value: non-negative integer (0 = keep forever). */
function parseDayField(raw: unknown): number | { error: string } {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      return { error: "must be a non-negative integer" };
    }
    return raw;
  }
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    return parseInt(raw.trim(), 10);
  }
  return { error: "must be a non-negative integer" };
}

export const retentionRoutes: FastifyPluginAsync<RetentionRoutesOptions> = async (
  fastify,
  opts
) => {
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Portal-Api-Version", "1");
    return payload;
  });

  /**
   * Guard shared by every route here: a resolved principal carrying the admin
   * scope. Returns the principal on success, or sends the error reply and
   * returns null.
   */
  function requireAdmin(
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ): ApiKeyPrincipal | null {
    const principal = request.principal;
    if (!principal) {
      reply.code(401).send({ error: "unauthorized", message: "Missing principal." });
      return null;
    }
    if (!principal.scopes.includes(SCOPE_RETENTION_ADMIN)) {
      reply.code(403).send({
        error: "forbidden",
        message: "This operation requires admin privileges.",
      });
      return null;
    }
    return principal;
  }

  // --- Read effective retention windows ---------------------------------
  fastify.get(
    "/api/v1/portal/settings/retention",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const tenantId = principal.config.tenantId;
      const windows = await resolveRetentionWindows(
        opts.retentionConfig,
        opts.settingsRepository,
        tenantId
      );
      const overrides = await opts.settingsRepository.getAll(tenantId);
      const hasOverride = (key: string): boolean =>
        overrides[key] !== undefined && overrides[key].trim() !== "";

      return {
        retention: {
          eventsDays: windows.eventsDays,
          sessionsDays: windows.sessionsDays,
          replayDays: windows.replayDays,
        },
        defaults: {
          eventsDays: opts.retentionConfig.eventsDays,
          sessionsDays: opts.retentionConfig.sessionsDays,
          replayDays: opts.retentionConfig.replayDays,
        },
        // Persisted overrides are supported (a settings table exists), so the
        // portal can offer an editable form rather than read-only.
        editable: true,
        source: {
          eventsDays: hasOverride(SETTING_RETENTION_EVENTS_DAYS) ? "override" : "env",
          sessionsDays: hasOverride(SETTING_RETENTION_SESSIONS_DAYS) ? "override" : "env",
          replayDays: hasOverride(SETTING_RETENTION_REPLAY_DAYS) ? "override" : "env",
        },
        purge: {
          enabled: opts.retentionConfig.purgeEnabled,
          intervalHours: opts.retentionConfig.purgeIntervalHours,
          batchSize: opts.retentionConfig.purgeBatchSize,
        },
      };
    }
  );

  // --- Update retention windows (persisted) -----------------------------
  fastify.put(
    "/api/v1/portal/settings/retention",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const body = (request.body ?? {}) as Record<string, unknown>;
      const updates: Array<{ field: string; setting: string; value: number }> = [];
      for (const [field, setting] of Object.entries(FIELD_TO_SETTING)) {
        if (!(field in body)) continue;
        const parsed = parseDayField(body[field]);
        if (typeof parsed === "object") {
          reply.code(400);
          return {
            error: "invalid_request",
            message: `\`${field}\` ${parsed.error}.`,
          };
        }
        updates.push({ field, setting, value: parsed });
      }
      if (updates.length === 0) {
        reply.code(400);
        return {
          error: "invalid_request",
          message:
            "Provide at least one of eventsDays, sessionsDays, replayDays.",
        };
      }

      const tenantId = principal.config.tenantId;
      const changed: Record<string, number> = {};
      for (const u of updates) {
        await opts.settingsRepository.set(tenantId, u.setting, String(u.value));
        changed[u.field] = u.value;
      }

      // Audit the change (non-fatal). Metadata carries the new values only —
      // no PII, just the day-windows.
      await recordAudit(
        opts.auditSink,
        tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.SETTINGS_UPDATE,
          targetType: "retention",
          targetId: null,
          metadata: { retention: changed },
        },
        request.log
      );

      const windows = await resolveRetentionWindows(
        opts.retentionConfig,
        opts.settingsRepository,
        tenantId
      );
      return {
        retention: {
          eventsDays: windows.eventsDays,
          sessionsDays: windows.sessionsDays,
          replayDays: windows.replayDays,
        },
        updated: changed,
      };
    }
  );

  // --- Read tenant replay settings --------------------------------------
  // Source of truth for the SDK's replay policy + the portal toggle. Admin
  // read; values fall back to REPLAY_DEFAULTS when unset.
  fastify.get(
    "/api/v1/portal/settings/replay",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const view = await resolveReplaySettings(
        opts.settingsRepository,
        principal.config.tenantId
      );
      return {
        replay: {
          mode: view.mode,
          enabled: view.enabled,
          sampleRate: view.sampleRate,
          routeDenyList: view.routeDenyList,
        },
        defaults: {
          mode: REPLAY_DEFAULTS.mode,
          enabled: REPLAY_DEFAULTS.enabled,
          sampleRate: REPLAY_DEFAULTS.sampleRate,
          routeDenyList: [...REPLAY_DEFAULTS.routeDenyList],
        },
        editable: true,
      };
    }
  );

  // --- Update tenant replay settings (persisted, audited) ---------------
  fastify.put(
    "/api/v1/portal/settings/replay",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const body = (request.body ?? {}) as Record<string, unknown>;
      const changed: Record<string, unknown> = {};
      const tenantId = principal.config.tenantId;

      if ("mode" in body) {
        // This server is all-or-nothing: only 'auto'/'off'. 'manual' recording
        // needs an external consent trigger this server does not provide, so it
        // is rejected outright rather than silently downgraded.
        if (body.mode !== "auto" && body.mode !== "off") {
          reply.code(400);
          return {
            error: "invalid_request",
            message:
              "`mode` must be 'auto' or 'off'. Manual replay requires an external consent trigger this server does not provide.",
          };
        }
        await opts.settingsRepository.set(
          tenantId,
          SETTING_REPLAY_MODE,
          body.mode
        );
        changed.mode = body.mode;
      }

      if ("enabled" in body) {
        if (typeof body.enabled !== "boolean") {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`enabled` must be a boolean.",
          };
        }
        await opts.settingsRepository.set(
          tenantId,
          SETTING_REPLAY_ENABLED,
          String(body.enabled)
        );
        changed.enabled = body.enabled;
      }

      if ("sampleRate" in body) {
        const n = body.sampleRate;
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`sampleRate` must be a number in [0, 1].",
          };
        }
        await opts.settingsRepository.set(
          tenantId,
          SETTING_REPLAY_SAMPLE_RATE,
          String(n)
        );
        changed.sampleRate = n;
      }

      if ("routeDenyList" in body) {
        const list = body.routeDenyList;
        if (
          !Array.isArray(list) ||
          !list.every((x) => typeof x === "string")
        ) {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`routeDenyList` must be an array of strings.",
          };
        }
        await opts.settingsRepository.set(
          tenantId,
          SETTING_REPLAY_ROUTE_DENY_LIST,
          JSON.stringify(list)
        );
        changed.routeDenyList = list;
      }

      if (Object.keys(changed).length === 0) {
        reply.code(400);
        return {
          error: "invalid_request",
          message:
            "Provide at least one of mode, enabled, sampleRate, routeDenyList.",
        };
      }

      await recordAudit(
        opts.auditSink,
        tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.SETTINGS_UPDATE,
          targetType: "replay",
          targetId: null,
          metadata: { replay: changed },
        },
        request.log
      );

      const view = await resolveReplaySettings(
        opts.settingsRepository,
        tenantId
      );
      return {
        replay: {
          mode: view.mode,
          enabled: view.enabled,
          sampleRate: view.sampleRate,
          routeDenyList: view.routeDenyList,
        },
        updated: changed,
      };
    }
  );

  // --- Read tenant webhook settings -------------------------------------
  // Admin read. The secret is WRITE-ONLY: we never return it — only a flag
  // saying whether one is configured.
  fastify.get(
    "/api/v1/portal/settings/webhook",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const config = await resolveWebhookConfig(
        opts.settingsRepository,
        principal.config.tenantId
      );
      return {
        webhook: toWebhookSettingsView(config),
        defaults: {
          enabled: WEBHOOK_DEFAULTS.enabled,
          url: WEBHOOK_DEFAULTS.url,
        },
        editable: true,
      };
    }
  );

  // --- Update tenant webhook settings (persisted, audited) --------------
  // `secret` is accepted but never returned. An empty-string `secret` clears
  // it. The audit row records targetType `webhook` and NEVER the secret value.
  fastify.put(
    "/api/v1/portal/settings/webhook",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const body = (request.body ?? {}) as Record<string, unknown>;
      const tenantId = principal.config.tenantId;
      // Audit-safe summary: which fields changed, never the secret value.
      const changed: Record<string, unknown> = {};

      if ("enabled" in body) {
        if (typeof body.enabled !== "boolean") {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`enabled` must be a boolean.",
          };
        }
        await opts.settingsRepository.set(
          tenantId,
          SETTING_WEBHOOK_ENABLED,
          String(body.enabled)
        );
        changed.enabled = body.enabled;
      }

      if ("url" in body) {
        if (typeof body.url !== "string") {
          reply.code(400);
          return { error: "invalid_request", message: "`url` must be a string." };
        }
        const url = body.url.trim();
        // Allow clearing the URL with an empty string; otherwise require https
        // (minimal SSRF guard — the admin owns the URL).
        if (url !== "" && !isHttpsUrl(url)) {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`url` must be a valid https URL.",
          };
        }
        await opts.settingsRepository.set(tenantId, SETTING_WEBHOOK_URL, url);
        changed.url = url;
      }

      if ("secret" in body) {
        if (typeof body.secret !== "string") {
          reply.code(400);
          return {
            error: "invalid_request",
            message: "`secret` must be a string.",
          };
        }
        // Persist verbatim. NEVER echoed back; only `secretConfigured` is
        // surfaced. An empty string clears the secret.
        await opts.settingsRepository.set(
          tenantId,
          SETTING_WEBHOOK_SECRET,
          body.secret
        );
        // Audit metadata records that the secret changed — never its value.
        changed.secret = body.secret.length > 0 ? "set" : "cleared";
      }

      if (Object.keys(changed).length === 0) {
        reply.code(400);
        return {
          error: "invalid_request",
          message: "Provide at least one of enabled, url, secret.",
        };
      }

      await recordAudit(
        opts.auditSink,
        tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.SETTINGS_UPDATE,
          targetType: "webhook",
          targetId: null,
          metadata: { webhook: changed },
        },
        request.log
      );

      const config = await resolveWebhookConfig(opts.settingsRepository, tenantId);
      return {
        webhook: toWebhookSettingsView(config),
        updated: changed,
      };
    }
  );

  // --- Send a test webhook ---------------------------------------------
  // Admin action: sign + POST a sample payload to the configured URL and
  // return the delivery result. Requires the webhook to have an https URL and
  // a secret; `enabled` is NOT required (an admin may test before enabling).
  // Like every dispatch, the outcome is recorded as a `webhook.dispatch`
  // audit row. The secret is never returned.
  const testHttpClient =
    opts.webhookHttpClient ?? new FetchWebhookHttpClient();
  fastify.post(
    "/api/v1/portal/settings/webhook/test",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const tenantId = principal.config.tenantId;
      const config = await resolveWebhookConfig(opts.settingsRepository, tenantId);
      if (!isHttpsUrl(config.url)) {
        reply.code(400);
        return {
          error: "invalid_request",
          message: "Configure a valid https webhook URL before sending a test.",
        };
      }
      if (config.secret.length === 0) {
        reply.code(400);
        return {
          error: "invalid_request",
          message: "Configure a webhook secret before sending a test.",
        };
      }

      const samplePayload: WebhookReportPayload = {
        tenantId,
        env: principal.env,
        sessionId: null,
        supportCode: "RT-TEST00",
        description: "This is a test report from the ResolveTrace portal.",
        context: { test: true },
        recentContext: [],
        occurredAt: new Date().toISOString(),
      };

      const result = await deliverWebhook(
        {
          httpClient: testHttpClient,
          auditSink: opts.auditSink,
          policy: opts.webhookDispatchPolicy,
          logger: request.log,
        },
        tenantId,
        actorFor(principal),
        config,
        samplePayload,
        "support.report_submitted.test"
      );

      if (result.status !== "delivered") {
        reply.code(502);
      }
      return {
        result: {
          status: result.status,
          attempts: result.attempts,
          httpStatus: result.httpStatus ?? null,
          error: result.error ?? null,
        },
      };
    }
  );

  // --- On-demand purge --------------------------------------------------
  fastify.post(
    "/api/v1/portal/retention/purge",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const tenantId = principal.config.tenantId;
      const counts = await runPurge(
        {
          purgeStore: opts.purgeStore,
          storage: opts.storage,
          settingsRepository: opts.settingsRepository,
          auditSink: opts.auditSink,
          retentionConfig: opts.retentionConfig,
        },
        tenantId,
        actorFor(principal),
        new Date(),
        request.log
      );

      return {
        purged: {
          events: counts.events,
          sessions: counts.sessions,
          replayObjects: counts.replayObjects,
        },
      };
    }
  );

  // --- Targeted session deletion / erasure ------------------------------
  fastify.delete(
    "/api/v1/portal/sessions/:sessionId",
    { config: { rateLimit: opts.rateLimitOptions } },
    async (request, reply) => {
      const principal = requireAdmin(request, reply);
      if (!principal) return reply;

      const { sessionId } = request.params as { sessionId: string };
      const tenantId = principal.config.tenantId;

      const result = await deleteSessionCascade(
        {
          purgeStore: opts.purgeStore,
          storage: opts.storage,
          auditSink: opts.auditSink,
        },
        tenantId,
        sessionId,
        actorFor(principal),
        request.log
      );

      if (!result.found) {
        reply.code(404);
        return {
          error: "not_found",
          message: `No session with id ${sessionId}`,
        };
      }

      return {
        deleted: {
          sessionId,
          eventsDeleted: result.eventsDeleted,
          replayObjects: result.replayObjects,
        },
      };
    }
  );
};
