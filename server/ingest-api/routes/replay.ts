/**
 * POST /v1/replay/signed-url — mint a pre-signed upload URL.
 * POST /v1/replay/complete — verify the uploaded chunk and persist the manifest.
 *
 * The canonical chunk key is derived server-side from the tenant id, session
 * id, and chunk sequence. The SDK never supplies the key on the first leg —
 * we return it, and it's echoed back on `/complete`. The key pattern is:
 *
 *     <tenantId>/<sessionId>/<sequence>.rrweb
 *
 * On `/complete` we re-derive the key and reject if the payload contains a
 * different one.
 *
 * Persistence (Wave-24): after the HeadObject verify, `/complete` INSERTs a
 * `replay_manifest` row AND increments `sessions.replay_chunk_count`. The
 * insert is idempotent on `(tenant, session, sequence)` — a repeat for the
 * same sequence updates the row and does NOT re-increment the counter.
 *
 * Policy (Wave-24): both legs honour the tenant replay policy. When replay is
 * disabled for the tenant, the upload is rejected (403) so a misconfigured /
 * over-eager SDK cannot persist replay against tenant policy. The route
 * deny-list is enforced SDK-side (A1) from the same tenant settings this
 * server persists + exposes — it cannot be enforced from the upload body
 * because the public `replay.json` request schema (strict, no extra props)
 * carries no route name, and adding one would be a contract change.
 *
 * The sha256 compare is performed via `storage.headObject()` when the
 * backend reports a checksum; otherwise we accept the client-asserted digest.
 */

import { FastifyPluginAsync } from "fastify";
import { ObjectNotFoundError, ObjectStorage } from "../../storage/index.js";
import type {
  ReplayManifestStore,
  ReplayScrubberReport,
  SettingsRepository,
} from "../types.js";
import { isReplayAllowed, resolveReplaySettings } from "../replay-settings.js";

export interface ReplayRoutesOptions {
  storage: ObjectStorage;
  /** Manifest persistence (migration 006). */
  replayManifestStore: ReplayManifestStore;
  /** Tenant settings source for the replay policy (enabled / deny-list). */
  settingsRepository: SettingsRepository;
  /** Signed-URL lifetime in seconds. Default 600 (10 minutes). */
  signedUrlTtlSeconds?: number;
  signedUrlRateLimit?: import("@fastify/rate-limit").RateLimitOptions;
  completeRateLimit?: import("@fastify/rate-limit").RateLimitOptions;
}

const REPLAY_CONTENT_TYPE = "application/vnd.resolvetrace.replay+rrweb";
// Tenant segment: either a lowercase slug (the single-tenant default,
// "oss-single-tenant") or an uppercase Crockford-base32 ULID. Tenant ids come
// from the deployment's TenantConfigResolver; ULID ids were previously
// rejected here, so the signed-url route minted keys that this same server
// then 400'd at /v1/replay/complete. The exact-match check against buildKey()
// below is the real ownership guard; this pattern is a format backstop only.
const CHUNK_KEY_PATTERN =
  /^(?:[a-z0-9-]{1,64}|[0-9A-HJKMNP-TV-Z]{26})\/[0-9A-HJKMNP-TV-Z]{26}\/\d+\.rrweb$/;

export const replayRoutes: FastifyPluginAsync<ReplayRoutesOptions> = async (
  fastify,
  opts
) => {
  const ttl = opts.signedUrlTtlSeconds ?? 600;

  fastify.post(
    "/v1/replay/signed-url",
    {
      config: { rateLimit: opts.signedUrlRateLimit },
    },
    async (request, reply) => {
      const body = request.validateBody("ReplaySignedUrlRequest") as {
        sessionId: string;
        sequence: number;
        approxBytes: number;
        contentType: string;
      };

      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized" };
      }
      const tenantId = principal.config.tenantId;

      // Enforce tenant replay policy before minting an upload URL: a disabled
      // tenant gets nothing to upload to.
      const policy = await resolveReplaySettings(
        opts.settingsRepository,
        tenantId
      );
      if (!isReplayAllowed(policy).allowed) {
        reply.code(403);
        return {
          error: "replay_disabled",
          message: "Replay capture is disabled for this tenant.",
        };
      }

      const key = buildKey(tenantId, body.sessionId, body.sequence);
      const signed = await opts.storage.createSignedUploadUrl({
        key,
        contentType: REPLAY_CONTENT_TYPE,
        maxBytes: body.approxBytes,
        expiresInSeconds: ttl,
      });

      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      reply.code(201);
      return {
        uploadUrl: signed.url,
        key,
        expiresAt,
        maxBytes: body.approxBytes,
        requiredHeaders: signed.headers,
      };
    }
  );

  fastify.post(
    "/v1/replay/complete",
    {
      config: { rateLimit: opts.completeRateLimit },
    },
    async (request, reply) => {
      const body = request.validateBody("ReplayManifestRequest") as {
        sessionId: string;
        sequence: number;
        key: string;
        bytes: number;
        sha256: string;
        clientUploadedAt: string;
        scrubber: ReplayScrubberReport;
      };

      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized" };
      }
      const tenantId = principal.config.tenantId;

      // Policy first — never persist a manifest for a disabled tenant.
      const policy = await resolveReplaySettings(
        opts.settingsRepository,
        tenantId
      );
      if (!isReplayAllowed(policy).allowed) {
        reply.code(403);
        return {
          error: "replay_disabled",
          message: "Replay capture is disabled for this tenant.",
        };
      }

      // The key MUST match the server-derived pattern anchored to the caller's
      // tenant id. Rejecting anything else prevents a client from pointing the
      // manifest at an object it doesn't own.
      const expectedKey = buildKey(tenantId, body.sessionId, body.sequence);
      if (body.key !== expectedKey) {
        reply.code(400);
        return {
          error: "key_mismatch",
          message:
            "Manifest key does not match the canonical tenant/session/sequence layout.",
        };
      }
      if (!CHUNK_KEY_PATTERN.test(body.key)) {
        reply.code(400);
        return {
          error: "key_format",
          message: "Manifest key violates the chunk-key format.",
        };
      }

      let metadata;
      try {
        metadata = await opts.storage.headObject(body.key);
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          reply.code(409);
          return {
            error: "stage1_precondition_failed",
            message: "Replay chunk not found in storage.",
          };
        }
        throw err;
      }

      if (metadata.size !== body.bytes) {
        reply.code(409);
        return {
          error: "integrity_check_failed",
          message: "Stored byte length differs from manifest.",
        };
      }

      // When the backend reports a SHA-256 checksum, compare. When it doesn't,
      // we accept the client-asserted digest — real checksum verification
      // requires body download (tracked as a follow-up in README).
      if (
        metadata.sha256 !== null &&
        metadata.sha256.toLowerCase() !== body.sha256.toLowerCase()
      ) {
        reply.code(409);
        return {
          error: "integrity_check_failed",
          message: "Stored checksum differs from manifest.",
        };
      }

      // Persist the manifest row + bump the session counter. Idempotent on a
      // repeated sequence: the row is updated and the counter is NOT
      // double-incremented (the store only increments on a first-seen insert).
      await opts.replayManifestStore.recordChunk(tenantId, {
        sessionId: body.sessionId,
        sequence: body.sequence,
        key: body.key,
        bytes: body.bytes,
        sha256: body.sha256,
        scrubber: body.scrubber ?? null,
        clientUploadedAt: body.clientUploadedAt ?? null,
      });

      reply.code(200);
      return {
        sessionId: body.sessionId,
        sequence: body.sequence,
        acceptedAt: new Date().toISOString(),
        durable: true,
      };
    }
  );
};

function buildKey(
  tenantId: string,
  sessionId: string,
  sequence: number
): string {
  return `${tenantId}/${sessionId}/${sequence}.rrweb`;
}
