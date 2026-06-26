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
import {
  AuditRepository,
  AuditSink,
  EventRepository,
  ReplayManifestStore,
  SessionRepository,
} from "../types.js";
import type { ObjectStorage } from "../../storage/index.js";
import { isValidSupportCode, normalizeSupportCode } from "../support-code.js";
import {
  AuditAction,
  PRINCIPAL_PORTAL_SERVICE,
  recordAudit,
  SCOPE_AUDIT_READ,
} from "../audit.js";
import type { ApiKeyPrincipal } from "../../tenant-resolver/index.js";

export interface PortalRoutesOptions {
  sessionRepository: SessionRepository;
  eventRepository: EventRepository;
  auditSink: AuditSink;
  auditRepository: AuditRepository;
  /** Manifest read surface for the replay player read-side. */
  replayManifestStore: ReplayManifestStore;
  /** Object storage, for minting time-boxed signed GET URLs per chunk. */
  storage: ObjectStorage;
  /** Signed download-URL lifetime in seconds. Default 300 (5 minutes). */
  replayDownloadTtlSeconds?: number;
  rateLimitOptions?: import("@fastify/rate-limit").RateLimitOptions;
}

/**
 * Resolve the audit `actor` string for an API-key/bearer principal. We never
 * log the secret or the raw key; the `jti` is a non-sensitive key identifier,
 * and we fall back to a stable service label so rows are always attributable.
 */
function actorFor(principal: ApiKeyPrincipal): string {
  return principal.jti
    ? `${PRINCIPAL_PORTAL_SERVICE}:${principal.jti}`
    : PRINCIPAL_PORTAL_SERVICE;
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
          supportCode: s.supportCode,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          eventCount: s.eventCount,
          appVersion: s.appVersion,
          releaseChannel: s.releaseChannel,
          // Wave-24: surface the replay counter so the portal list can show a
          // "has replay" indicator without a per-row manifest fetch.
          replayChunkCount: s.replayChunkCount,
        })),
        nextCursor: page.nextCursor ?? null,
      };
    }
  );

  // Resolve a session by its per-session support code. Lenient on input
  // (case-insensitive, dashes/spaces stripped, Crockford I/L->1 and O->0)
  // so support staff can type a code as the user reads it aloud. Tenant-
  // scoped. The distinct extra path segment keeps this from colliding with
  // the `/:sessionId` route below.
  fastify.get(
    "/api/v1/portal/sessions/by-support-code/:code",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }

      const { code } = request.params as { code: string };
      const normalized = normalizeSupportCode(code ?? "");
      if (!isValidSupportCode(normalized)) {
        reply.code(400);
        return {
          error: "invalid_request",
          message: "`code` is not a valid support code.",
        };
      }

      const session = await opts.sessionRepository.findBySupportCode(
        principal.config.tenantId,
        normalized
      );

      // Audit the lookup. Record only a hit/miss flag and (on a hit) the
      // resolved session id — NEVER the raw support code, which is itself a
      // semi-sensitive shareable token, nor any PII.
      await recordAudit(
        opts.auditSink,
        principal.config.tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.SUPPORT_CODE_LOOKUP,
          targetType: session ? "session" : null,
          targetId: session ? session.sessionId : null,
          metadata: { result: session ? "hit" : "miss" },
        },
        request.log
      );

      if (!session) {
        reply.code(404);
        return {
          error: "not_found",
          message: `No session for support code ${normalized}`,
        };
      }

      return {
        session: {
          sessionId: session.sessionId,
          supportCode: session.supportCode,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          endedReason: session.endedReason,
          appVersion: session.appVersion,
          releaseChannel: session.releaseChannel,
          userAnonId: session.userAnonId,
          eventCount: session.eventCount,
        },
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

      // Audit the sensitive read of a session's detail. The session id is the
      // target; no PII in metadata.
      await recordAudit(
        opts.auditSink,
        principal.config.tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.SESSION_VIEW,
          targetType: "session",
          targetId: sessionId,
        },
        request.log
      );

      const eventsPage = await opts.eventRepository.listBySession(
        principal.config.tenantId,
        sessionId,
        { limit, cursor }
      );

      return {
        session: {
          sessionId: session.sessionId,
          supportCode: session.supportCode,
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
          // Canonical-taxonomy fields (migration 002) needed by the
          // session-detail timeline to render frustration / error / perf
          // breadcrumbs with severity colouring and duration / status badges.
          schemaVersion: e.schemaVersion,
          context: e.context,
          severity: e.severity,
          durationMs: e.durationMs,
          httpStatus: e.httpStatus,
          // Caller identity stamped by client.identify(...), or null
          // (migration 007). Lets the session-detail view attribute events.
          actor: e.actor,
        })),
        eventsNextCursor: eventsPage.nextCursor ?? null,
      };
    }
  );

  // Replay read-side (Wave-24). Lists a session's chunk manifest and mints a
  // short-lived signed GET URL per chunk so the portal player can fetch the
  // (masked) chunk bytes directly from storage. RBAC-admin (`audit:read`);
  // viewers get 403. Tenant-scoped. EACH access writes a `replay.access` audit
  // entry via the Wave-23 non-fatal writer.
  const replayDownloadTtl = opts.replayDownloadTtlSeconds ?? 300;
  fastify.get(
    "/api/v1/portal/sessions/:sessionId/replay",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }
      if (!principal.scopes.includes(SCOPE_AUDIT_READ)) {
        reply.code(403);
        return {
          error: "forbidden",
          message: "Accessing replay requires admin privileges.",
        };
      }

      const { sessionId } = request.params as { sessionId: string };
      const tenantId = principal.config.tenantId;

      const manifest = await opts.replayManifestStore.listBySession(
        tenantId,
        sessionId
      );

      // Mint a time-boxed signed GET URL per chunk. Sequential is fine — a
      // session has a small number of chunks.
      const chunks = [];
      for (const row of manifest) {
        const signed = await opts.storage.createSignedDownloadUrl({
          key: row.key,
          expiresInSeconds: replayDownloadTtl,
        });
        chunks.push({
          sequence: row.sequence,
          bytes: row.bytes,
          sha256: row.sha256,
          scrubber: row.scrubber,
          uploadedAt: row.uploadedAt,
          clientUploadedAt: row.clientUploadedAt,
          url: signed.url,
          urlExpiresAt: signed.expiresAt,
        });
      }

      // Audit the access (non-fatal). Record the session and how many chunks
      // were surfaced — never the signed URLs or any PII.
      await recordAudit(
        opts.auditSink,
        tenantId,
        {
          actor: actorFor(principal),
          action: AuditAction.REPLAY_ACCESS,
          targetType: "session",
          targetId: sessionId,
          metadata: { chunkCount: chunks.length },
        },
        request.log
      );

      return {
        sessionId,
        chunkCount: chunks.length,
        urlTtlSeconds: replayDownloadTtl,
        chunks,
      };
    }
  );

  // Admin-only audit query. Tenant-scoped, newest-first, paginated via an
  // opaque cursor. RBAC: the principal must carry the `audit:read` scope
  // (admin); viewers lack it and get 403. Backs the portal `/audit` view (A3).
  fastify.get(
    "/api/v1/portal/audit",
    {
      config: { rateLimit: opts.rateLimitOptions },
    },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized", message: "Missing principal." };
      }
      if (!principal.scopes.includes(SCOPE_AUDIT_READ)) {
        reply.code(403);
        return {
          error: "forbidden",
          message: "Reading the audit log requires admin privileges.",
        };
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

      const page = await opts.auditRepository.list(principal.config.tenantId, {
        limit,
        cursor,
      });

      return {
        entries: page.entries.map((e) => ({
          actor: e.actor,
          action: e.action,
          targetType: e.targetType,
          targetId: e.targetId,
          occurredAt: e.occurredAt,
          metadata: e.metadata,
        })),
        nextCursor: page.nextCursor ?? null,
      };
    }
  );
};
