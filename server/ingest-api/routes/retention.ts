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
import type { ApiKeyPrincipal } from "../../tenant-resolver/index.js";

export interface RetentionRoutesOptions {
  purgeStore: PurgeStore;
  storage: ObjectStorage;
  settingsRepository: SettingsRepository;
  auditSink: AuditSink;
  retentionConfig: RetentionConfig;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
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
