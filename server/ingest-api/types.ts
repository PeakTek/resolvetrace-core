/**
 * Shared types used by the ingest-api routes and plugins.
 *
 * Handler-visible request augmentation lives in `plugins/auth.ts` (module
 * augmentation of `FastifyRequest.principal`). Route input/output body
 * shapes come from the embedded JSON schemas.
 */

import { ObjectStorage } from "../storage/index.js";
import { TenantConfigResolver } from "../tenant-resolver/index.js";
import type { AuthProvider } from "../auth/index.js";
import type { RetentionConfig } from "./retention-config.js";

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
  /**
   * Record (or upsert) the session-start row and return the per-session
   * support code. The code is minted server-side on first start and is
   * idempotent per `(tenantId, sessionId)`: a repeat start with the same
   * `sessionId` returns the SAME code rather than minting a new one.
   */
  recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<SessionStartResult>;
  recordEnd(tenantId: string, record: SessionEndRecord): Promise<void>;
}

/** Result of `SessionSink.recordStart`. */
export interface SessionStartResult {
  /** The per-session support code (8-char Crockford base32, uppercase). */
  supportCode: string;
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

  /**
   * Resolve a session by its per-session support code. `supportCode` is the
   * normalized canonical value (uppercase, 8-char Crockford); callers must
   * normalize lenient user input first. Tenant-scoped; returns `null` when no
   * session for the tenant carries that code.
   */
  findBySupportCode(
    tenantId: string,
    supportCode: string
  ): Promise<SessionRecord | null>;
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
  /**
   * Per-session support code (8-char Crockford base32, uppercase canonical),
   * or null for legacy rows minted before migration 003.
   */
  supportCode: string | null;
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
  /**
   * Canonical-taxonomy fields persisted by migration 002. All nullable —
   * legacy rows and producers that omit them read back as `null`. Surfaced to
   * the portal session-detail view so auto-captured frustration / error /
   * perf events can be rendered (type-aware rows, severity colouring,
   * duration / http-status badges) without a second round-trip.
   */
  schemaVersion: number | null;
  /** Per-event global context (release/locale/route/device/…) or null. */
  context: Record<string, unknown> | null;
  severity: "info" | "warn" | "error" | null;
  durationMs: number | null;
  httpStatus: number | null;
}

/**
 * Per-event global context. Optional on the envelope; mirrors the contract's
 * `EventContext` (`events.json#/definitions/EventContext`). When present,
 * releaseVersion/locale/market/diagnosticsLevel are required. Stored verbatim
 * as JSON on the event row for later session-detail rendering.
 */
export interface EventContext {
  releaseVersion: string;
  locale: string;
  market: string;
  diagnosticsLevel: "essential" | "standard" | "assisted_support";
  routeName?: string;
  routeType?: string;
  componentId?: string;
  componentType?: string;
  browserFamily?: string;
  browserVersion?: string;
  osFamily?: string;
  deviceType?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  featureFlags?: Record<string, unknown>;
  experimentVariant?: string;
  networkState?: string;
  pageUrl?: string;
  supportCode?: string;
}

export interface ValidatedEvent {
  /**
   * Major version of the shared event schema this envelope conforms to.
   * Producers stamp the current major (1); the events route rejects
   * unsupported majors before persistence (version-negotiation contract).
   */
  schemaVersion: number;
  eventId: string;
  sessionId?: string;
  type: string;
  capturedAt: string;
  context?: EventContext;
  severity?: "info" | "warn" | "error";
  durationMs?: number;
  httpStatus?: number;
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
   * Free-form, non-PII session attributes (e.g. `page_url`, `viewport`) sent
   * by the browser SDK on session start and extended via `sessionAttributes`.
   */
  attributes?: Record<string, unknown>;
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

/**
 * A single audit record as written by the app and returned by the query
 * endpoint. `actor` is the authenticated principal (a user id, or a stable
 * label like `portal-service` for API-key/bearer access — NEVER the secret).
 * `metadata` is non-PII JSON only (hit/miss flags, counts, etc.).
 */
export interface AuditRecordInput {
  /** Authenticated principal identifier or a stable service label. */
  actor: string;
  /** One of the `AuditAction` constants (free-form text at the DB level). */
  action: string;
  /** Optional object class the action targeted, e.g. `session`. */
  targetType?: string | null;
  /** Optional identifier of the targeted object, e.g. a session id. */
  targetId?: string | null;
  /** Non-PII structured context. NEVER raw PII or secrets. */
  metadata?: Record<string, unknown> | null;
}

/** Read model returned by `AuditRepository`. */
export interface AuditRecord {
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** ISO 8601. */
  occurredAt: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Append-only sink for audit records. The Postgres implementation INSERTs a
 * row; the in-memory implementation appends to an array for tests. Callers
 * must NOT depend on the write succeeding — see `recordAudit`, which wraps a
 * sink so a failure is logged but never breaks the primary request.
 */
export interface AuditSink {
  append(tenantId: string, record: AuditRecordInput): Promise<void>;
}

/** Read-side access to the audit log. Consumed by the admin query endpoint. */
export interface AuditRepository {
  list(
    tenantId: string,
    opts: {
      /** Page size. Clamped to `[1, 200]` by the implementation. */
      limit: number;
      /** Opaque cursor returned by a previous call. */
      cursor?: string;
    }
  ): Promise<{ entries: AuditRecord[]; nextCursor?: string }>;
}

/**
 * Read/write access to the per-tenant key/value settings store (migration
 * 005). Used to persist admin overrides of the retention day-windows over the
 * environment defaults. The in-memory implementation backs tests and the
 * DATABASE_URL-less smoke path; the Postgres implementation hits `settings`.
 */
export interface SettingsRepository {
  /** Return all settings for a tenant as a key -> value map. */
  getAll(tenantId: string): Promise<Record<string, string>>;
  /** Upsert one setting. */
  set(tenantId: string, key: string, value: string): Promise<void>;
}

/**
 * The SDK scrubber/masking report carried on `POST /v1/replay/complete`
 * (replay.json `scrubber`). Persisted with the manifest row for audit parity
 * (which masking ruleset was in force when the chunk was captured).
 */
export interface ReplayScrubberReport {
  version: string;
  rulesDigest: string;
  applied: string[];
  budgetExceeded: boolean;
  durationMs?: number;
}

/** One persisted replay-chunk manifest row. */
export interface ReplayManifestRecord {
  sessionId: string;
  sequence: number;
  /** Canonical object key for the chunk. */
  key: string;
  bytes: number;
  sha256: string;
  scrubber: ReplayScrubberReport | null;
  /** Client-reported upload time (ISO 8601) or null. */
  clientUploadedAt: string | null;
  /** Server durable-accept time (ISO 8601). */
  uploadedAt: string;
}

/** Input for persisting one replay-chunk manifest row. */
export interface ReplayManifestInput {
  sessionId: string;
  sequence: number;
  key: string;
  bytes: number;
  sha256: string;
  scrubber?: ReplayScrubberReport | null;
  clientUploadedAt?: string | null;
}

/**
 * Persistence + read surface for the replay chunk manifest (migration 006).
 * Written on `/v1/replay/complete`, read by the portal player read-side, and
 * swept by retention / targeted erasure.
 */
export interface ReplayManifestStore {
  /**
   * Insert one manifest row and, when it is first-seen for
   * `(tenantId, sessionId, sequence)`, increment `sessions.replay_chunk_count`.
   * Idempotent: a repeat for the same sequence updates the row in place and
   * does NOT re-increment. Returns whether the row was newly inserted.
   */
  recordChunk(
    tenantId: string,
    input: ReplayManifestInput
  ): Promise<{ inserted: boolean }>;

  /** List a session's manifest rows in playback (sequence) order. */
  listBySession(
    tenantId: string,
    sessionId: string
  ): Promise<ReplayManifestRecord[]>;
}

/**
 * The storage-and-row surface the purge runner + targeted-deletion path need.
 * Deliberately narrow (only what those operations require) so it can be
 * implemented over Postgres in production and a fake in tests. All methods are
 * tenant-scoped and use bounded batches where they delete in a loop.
 */
export interface PurgeStore {
  /**
   * Delete up to `batchSize` `events` rows older than `cutoff` for the tenant,
   * looping until none remain. Returns the total number of rows deleted.
   * Skipped entirely by the caller when the events window is "keep forever".
   */
  purgeEventsOlderThan(
    tenantId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<number>;

  /**
   * Find sessions started before `cutoff` that still carry replay chunks, so
   * the caller can delete their storage objects. Returns `(sessionId,
   * replayChunkCount)` pairs, bounded to `limit` per call (caller loops).
   */
  listSessionsWithReplayOlderThan(
    tenantId: string,
    cutoff: Date,
    limit: number
  ): Promise<Array<{ sessionId: string; replayChunkCount: number }>>;

  /** Zero out `replay_chunk_count` for a session after its objects are gone. */
  clearReplayChunkCount(tenantId: string, sessionId: string): Promise<void>;

  /**
   * Return the exact object keys recorded in the manifest for a session, so
   * the caller can delete the storage objects authoritatively (rather than
   * re-deriving keys from a chunk count). Empty array when the session has no
   * manifest rows.
   */
  listReplayManifestKeys(
    tenantId: string,
    sessionId: string
  ): Promise<string[]>;

  /**
   * Delete all manifest rows for a session after its storage objects are gone.
   * Returns the number of rows deleted. Idempotent (a session with no rows is
   * a no-op returning 0).
   */
  deleteReplayManifest(
    tenantId: string,
    sessionId: string
  ): Promise<number>;

  /**
   * Delete up to `batchSize` `sessions` rows started before `cutoff` (and the
   * events that belong to them), looping until none remain. Returns the
   * sessions deleted and the per-session replay-chunk info for those sessions
   * so the caller can purge their storage objects too.
   */
  purgeSessionsOlderThan(
    tenantId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<{
    sessionsDeleted: number;
    eventsDeleted: number;
    replayChunks: Array<{ sessionId: string; replayChunkCount: number }>;
  }>;

  /**
   * Hard-delete one session and cascade: its events, then the session row.
   * Returns the events deleted and the session's prior `replay_chunk_count`
   * (0 when none / unknown) so the caller can delete storage objects, plus a
   * `found` flag for idempotency (false => no such session for the tenant).
   */
  deleteSession(
    tenantId: string,
    sessionId: string
  ): Promise<{ found: boolean; eventsDeleted: number; replayChunkCount: number }>;
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
  /** Append-only audit sink (governance feature #6). */
  auditSink: AuditSink;
  /** Read-side access to the audit log (admin query endpoint). */
  auditRepository: AuditRepository;
  /** Read/write key/value settings store (editable retention overrides). */
  settingsRepository: SettingsRepository;
  /** Persistence + read surface for the replay chunk manifest (migration 006). */
  replayManifestStore: ReplayManifestStore;
  /** Row + storage surface the purge runner and deletion path operate on. */
  purgeStore: PurgeStore;
  /**
   * Resolved retention configuration (env defaults). The portal-resolved
   * effective windows layer admin overrides from `settingsRepository` on top.
   */
  retentionConfig: RetentionConfig;
  /**
   * Optional auth provider backing the portal login endpoint. When absent the
   * login route is not registered (e.g. an ingest-only deployment).
   */
  authProvider?: AuthProvider;
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
