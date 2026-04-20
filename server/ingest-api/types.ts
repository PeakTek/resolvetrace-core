/**
 * Shared types used by the ingest-api routes and plugins.
 *
 * Handler-visible request augmentation lives in `plugins/auth.ts` (module
 * augmentation of `FastifyRequest.principal`). Route input/output body
 * shapes come from the embedded JSON schemas.
 */

import { ObjectStorage } from "../storage/index.js";
import { TenantConfigResolver } from "../tenant-resolver/index.js";

/** Pluggable event sink — replaced with real persistence in a later wave. */
export interface EventSink {
  /**
   * Enqueue a batch of already-validated events for processing. The in-memory
   * default resolves immediately; a future implementation backed by a real
   * queue returns once the write is durable.
   */
  enqueue(tenantId: string, events: ReadonlyArray<ValidatedEvent>): Promise<void>;
}

/** Pluggable session record sink. In-memory default; real DB lands later. */
export interface SessionSink {
  recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<void>;
  recordEnd(tenantId: string, record: SessionEndRecord): Promise<void>;
}

export interface ValidatedEvent {
  eventId: string;
  sessionId?: string;
  type: string;
  capturedAt: string;
  attributes?: Record<string, unknown>;
  scrubber: {
    version: string;
    rulesDigest: string;
    applied: string[];
    budgetExceeded: boolean;
    durationMs?: number;
  };
  clockSkewDetected?: boolean;
  sdk: {
    name: string;
    version: string;
    runtime?: string;
  };
}

export interface SessionStartRecord {
  sessionId: string;
  startedAt: string;
  appVersion?: string;
  releaseChannel?: string;
  client?: unknown;
  userAnonId?: string;
}

export interface SessionEndRecord {
  sessionId: string;
  endedAt: string;
  reason: string;
  eventCount?: number;
  replayChunkCount?: number;
}

/** Readiness probe. Implementations may probe DB, storage, or other deps. */
export interface ReadinessCheck {
  /** Short machine-readable name of the dependency being probed. */
  name: string;
  /** Return `true` for healthy, `false` for unhealthy. Must not throw. */
  check(): Promise<boolean>;
}

/**
 * Runtime wiring passed in to the Fastify app builder. All dependencies are
 * parameterised so tests can swap them for mocks.
 */
export interface IngestApiDependencies {
  resolver: TenantConfigResolver;
  storage: ObjectStorage;
  eventSink: EventSink;
  sessionSink: SessionSink;
  /**
   * Idempotency store. Implementations back this with an in-memory LRU or a
   * Redis instance depending on env.
   */
  idempotencyStore: IdempotencyStore;
  /** Optional list of readiness dependencies probed by `GET /ready`. */
  readinessChecks?: ReadinessCheck[];
  /**
   * Allowed CORS origins. Empty means `*`. Wire from `CORS_ORIGINS` env.
   */
  corsOrigins?: string[];
  /** Presigned-URL lifetime in seconds. Default 600. */
  signedUrlTtlSeconds?: number;
  /**
   * Per-class rate limits. If absent, defaults from ADR-0001 apply.
   * Numbers are requests per minute (Fastify's rate-limit plugin uses a
   * window size in ms; we convert).
   */
  rateLimits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
}

export type RateLimitClass =
  | "events"
  | "replay_signed_url"
  | "replay_complete"
  | "session";

/**
 * Rate-limit envelope per class. `soft` maps to `max`; burst headroom is
 * folded into the plugin's internal window with `hard`.
 */
export interface RateLimitBudget {
  /** Sustained RPS (soft ceiling). */
  soft: number;
  /** Hard-burst RPS (short-window cap). */
  hard: number;
}

/**
 * Idempotency store used for `(tenantId, eventId)` tuples. The OSS default
 * is an in-memory LRU; when `REDIS_URL` is configured, a Redis-backed
 * implementation is plugged in (not wired in Wave 4 — see README).
 */
export interface IdempotencyStore {
  /**
   * Returns `true` if the key was newly reserved (first-seen), `false` if a
   * prior reservation exists within the dedup window.
   */
  reserve(key: string, ttlSeconds: number): Promise<boolean>;
}
