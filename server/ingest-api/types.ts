/**
 * Shared types used by the ingest-api routes and plugins.
 *
 * Handler-visible request augmentation lives in `plugins/auth.ts` (module
 * augmentation of `FastifyRequest.principal`). Route input/output body
 * shapes come from the embedded JSON schemas.
 */

import { ObjectStorage } from "../storage/index.js";
import { TenantConfigResolver } from "../tenant-resolver/index.js";

/** Pluggable event sink. In-memory default for tests; Postgres in production. */
export interface EventSink {
  /**
   * Enqueue a batch of already-validated events for processing. The in-memory
   * default resolves immediately; the Postgres implementation returns once the
   * write is durable.
   */
  enqueue(tenantId: string, events: ReadonlyArray<ValidatedEvent>): Promise<void>;
}

/** Pluggable session record sink. In-memory default for tests; Postgres in production. */
export interface SessionSink {
  recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<void>;
  recordEnd(tenantId: string, record: SessionEndRecord): Promise<void>;
}

/**
 * Read-side access to stored sessions. Consumed by the portal query API.
 * Implementations map DB rows to plain `SessionRecord` objects with ISO
 * timestamps; callers do not see `pg.Pool` or DB row types.
 */
export interface SessionRepository {
  list(
    tenantId: string,
    opts: {
      /** Page size. Caller-supplied value is clamped to `[1, 200]`. Default 50. */
      limit: number;
      /** Opaque cursor returned by a previous call. */
      cursor?: string;
    }
  ): Promise<{ sessions: SessionRecord[]; nextCursor?: string }>;

  get(tenantId: string, sessionId: string): Promise<SessionRecord | null>;
}

/**
 * Read-side access to events scoped to a single session. Consumed by the
 * portal query API's session-detail route.
 */
export interface EventRepository {
  listBySession(
    tenantId: string,
    sessionId: string,
    opts: {
      /** Page size. Caller-supplied value is clamped to `[1, 1000]`. Default 200. */
      limit: number;
      /** Opaque cursor returned by a previous call. */
      cursor?: string;
    }
  ): Promise<{ events: EventRecord[]; nextCursor?: string }>;
}

/** Read model returned by `SessionRepository`. */
export interface SessionRecord {
  sessionId: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601 or null if the session is still open. */
  endedAt: string | null;
  endedReason: string | null;
  appVersion: string | null;
  releaseChannel: string | null;
  userAnonId: string | null;
  /** Live count from the events table — ignores any SDK-supplied value. */
  eventCount: number;
  replayChunkCount: number | null;
  client: unknown | null;
}

/** Read model returned by `EventRepository`. */
export interface EventRecord {
  eventId: string;
  sessionId: string | null;
  type: string;
  /** ISO 8601. */
  capturedAt: string;
  attributes: Record<string, unknown> | null;
  clockSkewDetected: boolean;
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
  /**
   * Latest known identity for this session. When present, the session row is
   * upserted with these fields so a re-issued start (e.g. after login)
   * reflects the current identity. Mid-session events ship their own actor
   * decoration; the row only changes when start is re-issued.
   */
  identify?: SessionIdentify;
}

/** Identity decoration optionally carried on `/v1/session/start`. */
export interface SessionIdentify {
  userId?: string | null;
  traits?: Record<string, unknown>;
}

export interface SessionEndRecord {
  sessionId: string;
  endedAt: string;
  reason: string;
  eventCount?: number;
  replayChunkCount?: number;
}

/**
 * Server-internal error raised by the event sink when one or more events in
 * a batch carry a `session_id` that does not resolve in the `sessions` table
 * for the requesting tenant. Surfaced by the `/v1/events` route as a 409
 * `session_unknown` response so the SDK can re-issue `/v1/session/start` and
 * retry the batch once.
 *
 * Only thrown when strict-session mode is enabled. In the default lenient
 * mode, the sink falls back to the auto-derive path and never raises this.
 */
export class SessionUnknownError extends Error {
  readonly unresolvedSessionIds: string[];
  constructor(unresolvedSessionIds: string[]) {
    super(
      `Unknown session(s) for this tenant: ${unresolvedSessionIds.join(", ")}`
    );
    this.name = "SessionUnknownError";
    this.unresolvedSessionIds = unresolvedSessionIds;
  }
}

/**
 * Server-internal error raised by the event sink when an event in the batch
 * is missing `session_id` while strict-session mode is enabled. Mapped by
 * the route to a 400 `session_required` response.
 */
export class SessionRequiredError extends Error {
  constructor() {
    super("session_id is required on every event in strict mode.");
    this.name = "SessionRequiredError";
  }
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
  /** Read-side access to stored sessions (portal API). */
  sessionRepository: SessionRepository;
  /** Read-side access to stored events (portal API). */
  eventRepository: EventRepository;
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
  /**
   * Optional. Drop a previously reserved key so the next call to `reserve`
   * with the same key returns `true` again. Used by the events route when a
   * batch is rejected before persistence (e.g. a strict-session 409) so the
   * SDK's retry of the same eventIds is not falsely flagged as duplicates.
   * Implementations that cannot support release safely (e.g. distributed
   * stores without strong consistency) may leave this unimplemented.
   */
  release?(key: string): Promise<void>;
}
