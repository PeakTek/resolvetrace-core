/**
 * POST /v1/replay/signed-url — mint a pre-signed upload URL.
 * POST /v1/replay/complete — verify the uploaded chunk and record the manifest.
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
 * The sha256 compare is performed via `storage.headObject()` when the
 * backend reports a checksum; otherwise we accept the client-asserted digest
 * (tracked as a gap in the README — Phase 1 storage adapter).
 */

import { FastifyPluginAsync } from "fastify";
import { ObjectNotFoundError, ObjectStorage } from "../../storage/index.js";

export interface ReplayRoutesOptions {
  storage: ObjectStorage;
  /** Signed-URL lifetime in seconds. Default 600 (10 minutes). */
  signedUrlTtlSeconds?: number;
  signedUrlRateLimit?: import("@fastify/rate-limit").RateLimitOptions;
  completeRateLimit?: import("@fastify/rate-limit").RateLimitOptions;
}

const REPLAY_CONTENT_TYPE = "application/vnd.resolvetrace.replay+rrweb";
const CHUNK_KEY_PATTERN = /^[a-z0-9-]{1,64}\/[0-9A-HJKMNP-TV-Z]{26}\/\d+\.rrweb$/;

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
      };

      const principal = request.principal;
      if (!principal) {
        reply.code(401);
        return { error: "unauthorized" };
      }
      const tenantId = principal.config.tenantId;

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
