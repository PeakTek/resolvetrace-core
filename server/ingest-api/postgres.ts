/**
 * Postgres-backed implementations of the event / session sinks and
 * repositories, plus a tiny migration runner.
 *
 * Kept in a single file so the whole persistence seam is easy to read.
 * No ORM — parameterized SQL via `pg.Pool` only. All methods accept a
 * minimal `PgPool` interface so tests can pass a fake without spinning
 * up a real Postgres.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import pg from "pg";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import {
  AuditRecord,
  AuditRecordInput,
  AuditRepository,
  AuditSink,
  EventRecord,
  EventRepository,
  EventSink,
  PurgeStore,
  ReplayManifestInput,
  ReplayManifestRecord,
  ReplayManifestStore,
  ReplayScrubberReport,
  SessionEndRecord,
  SessionRecord,
  SessionRepository,
  SessionRequiredError,
  SessionSink,
  SessionStartRecord,
  SessionStartResult,
  SettingsRepository,
  SessionUnknownError,
  ValidatedEvent,
} from "./types.js";
import { generateSupportCode } from "./support-code.js";

const { Pool: PoolCtor } = pg;

/**
 * Minimal `pg.Pool` surface we depend on. `pg.Pool` is structurally
 * compatible with this interface; tests can supply a plain object with the
 * same methods (no real Postgres required).
 */
export interface PgPool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export interface PgClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  release(err?: Error | boolean): void;
}

/** Thin factory so tests can override. */
export function createPgPool(databaseUrl: string): Pool {
  return new PoolCtor({ connectionString: databaseUrl });
}

// --- Migrations --------------------------------------------------------

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(SELF_DIR, "migrations");

/**
 * Run every `*.sql` migration under `./migrations` in lexical order.
 * Each unapplied version is executed in its own transaction; the filename
 * stem is recorded in `schema_migrations`. Already-applied versions are
 * skipped. Forward-only — rollbacks are a manual operation for now.
 */
export async function runMigrations(
  pool: PgPool,
  logger?: Pick<Logger, "info" | "debug" | "error">
): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const appliedRes = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations"
  );
  const applied = new Set(appliedRes.rows.map((r) => r.version));

  const entries = await fs.readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) {
      logger?.debug({ version }, "migration already applied");
      continue;
    }
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      logger?.info({ version }, "applied migration");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// --- Sinks -------------------------------------------------------------

/** Options for `PostgresEventSink`. */
export interface PostgresEventSinkOptions {
  /**
   * When `true`, events whose `session_id` does not resolve in the `sessions`
   * table for the tenant are rejected with `SessionUnknownError`, and events
   * missing `session_id` entirely are rejected with `SessionRequiredError`.
   *
   * When `false` (default), the legacy auto-derive path is taken: a session
   * row is upserted on first-seen using the event's `captured_at` as the
   * derived `started_at`, and events with `session_id = null` are persisted
   * as-is.
   */
  strictSessions?: boolean;
}

export class PostgresEventSink implements EventSink {
  private readonly strictSessions: boolean;

  constructor(
    private readonly pool: PgPool,
    options: PostgresEventSinkOptions = {}
  ) {
    this.strictSessions = options.strictSessions ?? false;
  }

  /**
   * Look up which of `sessionIds` have an existing row for `tenantId`. The
   * returned set contains the resolved IDs only; callers diff against the
   * requested IDs to find unresolved ones.
   */
  private async resolveSessionIds(
    tenantId: string,
    sessionIds: ReadonlyArray<string>
  ): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    const res = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM sessions
        WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
      [tenantId, [...sessionIds]]
    );
    return new Set(res.rows.map((r) => r.session_id));
  }

  async enqueue(
    tenantId: string,
    events: ReadonlyArray<ValidatedEvent>
  ): Promise<void> {
    if (events.length === 0) return;

    if (this.strictSessions) {
      // 1. Any event missing session_id fails the whole batch with 400.
      if (events.some((e) => !e.sessionId)) {
        throw new SessionRequiredError();
      }
      // 2. Pre-flight resolution: every distinct session_id must already
      //    exist for this tenant. The SDK is expected to have pipelined
      //    /v1/session/start ahead of this batch.
      const distinctIds = Array.from(
        new Set(events.map((e) => e.sessionId as string))
      );
      const resolved = await this.resolveSessionIds(tenantId, distinctIds);
      const unresolved = distinctIds.filter((id) => !resolved.has(id));
      if (unresolved.length > 0) {
        throw new SessionUnknownError(unresolved);
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const evt of events) {
        await client.query(
          `INSERT INTO events (
             tenant_id, event_id, session_id, type, captured_at,
             attributes, scrubber, sdk, clock_skew_detected,
             schema_version, context, severity, duration_ms, http_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (tenant_id, event_id) DO NOTHING`,
          [
            tenantId,
            evt.eventId,
            evt.sessionId ?? null,
            evt.type,
            evt.capturedAt,
            evt.attributes ? JSON.stringify(evt.attributes) : null,
            JSON.stringify(evt.scrubber),
            JSON.stringify(evt.sdk),
            evt.clockSkewDetected ?? false,
            evt.schemaVersion,
            evt.context ? JSON.stringify(evt.context) : null,
            evt.severity ?? null,
            evt.durationMs ?? null,
            evt.httpStatus ?? null,
          ]
        );
        // In strict mode the session row is guaranteed to exist (we
        // pre-flighted), so we skip the upsert. In lenient mode we keep the
        // legacy auto-derive: insert a minimal session row on first-seen so
        // listings stay correct even when the SDK never calls /session/start.
        // `started_at` uses LEAST semantics so an earlier explicit start
        // still wins.
        if (!this.strictSessions && evt.sessionId) {
          await client.query(
            `INSERT INTO sessions (tenant_id, session_id, started_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, session_id) DO UPDATE
               SET started_at = LEAST(sessions.started_at, EXCLUDED.started_at),
                   updated_at = now()`,
            [tenantId, evt.sessionId, evt.capturedAt]
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export class PostgresSessionSink implements SessionSink {
  constructor(private readonly pool: PgPool) {}

  /**
   * Postgres unique-violation SQLSTATE — surfaced when two concurrent starts
   * race the same generated code onto `uq_sessions_support_code`.
   */
  private static readonly PG_UNIQUE_VIOLATION = "23505";

  /**
   * Mint-or-return the support code for the session row, idempotently.
   *
   * The session row already exists (the upsert above guarantees it). This
   * sets `support_code` only when it is currently NULL — a repeat start with
   * the same `sessionId` keeps the original code — and returns the effective
   * code via `RETURNING`. On the rare per-tenant collision (another session
   * already holds the generated code) the unique index raises 23505 and we
   * retry with a fresh code, bounded.
   */
  private async mintSupportCode(
    tenantId: string,
    sessionId: string
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = generateSupportCode();
      try {
        const res = await this.pool.query<{ support_code: string }>(
          `UPDATE sessions
              SET support_code = COALESCE(support_code, $3),
                  updated_at   = now()
            WHERE tenant_id = $1 AND session_id = $2
          RETURNING support_code`,
          [tenantId, sessionId, candidate]
        );
        const code = res.rows[0]?.support_code;
        if (code) return code;
        // No row matched — should not happen since the upsert ran first.
        throw new Error(
          `session row missing for ${tenantId}:${sessionId} during support-code mint`
        );
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === PostgresSessionSink.PG_UNIQUE_VIOLATION) {
          // Generated code already taken for this tenant — try again.
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `Exhausted support-code generation attempts for ${tenantId}:${sessionId}`
    );
  }

  async recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<SessionStartResult> {
    // When the start carries an `identify` block, it wins outright over any
    // previously stored identity for this session. The SDK only re-issues
    // start with identify when it has new identity to project (e.g. a login
    // event); honoring last-writer-wins keeps the row in sync with the
    // SDK's view without needing a separate identify endpoint.
    const identifyProvided = record.identify !== undefined;
    const userIdFromIdentify = record.identify?.userId ?? null;
    const userAnonId =
      identifyProvided && userIdFromIdentify !== undefined
        ? userIdFromIdentify
        : record.userAnonId ?? null;
    // Compose the persisted client blob. If identify is present, embed it so
    // queries can see the latest traits without an extra column.
    let clientPayload: string | null = null;
    if (
      record.client !== undefined ||
      identifyProvided ||
      record.attributes !== undefined
    ) {
      const base =
        record.client !== undefined && record.client !== null
          ? (record.client as Record<string, unknown>)
          : {};
      const composed: Record<string, unknown> = { ...base };
      if (identifyProvided) {
        composed.identify = record.identify;
      }
      if (record.attributes !== undefined) {
        composed.attributes = record.attributes;
      }
      clientPayload = JSON.stringify(composed);
    }

    await this.pool.query(
      `INSERT INTO sessions (
         tenant_id, session_id, started_at,
         app_version, release_channel, user_anon_id, client
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET started_at      = LEAST(sessions.started_at, EXCLUDED.started_at),
             app_version     = COALESCE(EXCLUDED.app_version, sessions.app_version),
             release_channel = COALESCE(EXCLUDED.release_channel, sessions.release_channel),
             user_anon_id    = CASE
                                 WHEN $8::boolean THEN EXCLUDED.user_anon_id
                                 ELSE COALESCE(EXCLUDED.user_anon_id, sessions.user_anon_id)
                               END,
             client          = CASE
                                 WHEN $8::boolean THEN EXCLUDED.client
                                 ELSE COALESCE(EXCLUDED.client, sessions.client)
                               END,
             updated_at      = now()`,
      [
        tenantId,
        record.sessionId,
        record.startedAt,
        record.appVersion ?? null,
        record.releaseChannel ?? null,
        userAnonId,
        clientPayload,
        identifyProvided,
      ]
    );

    const supportCode = await this.mintSupportCode(
      tenantId,
      record.sessionId
    );
    return { supportCode };
  }

  async recordEnd(tenantId: string, record: SessionEndRecord): Promise<void> {
    // End may arrive before any start/events — upsert a minimal row so the
    // session still appears in listings. `started_at` defaults to `ended_at`
    // and is later overwritten by LEAST semantics if a real start arrives.
    await this.pool.query(
      `INSERT INTO sessions (
         tenant_id, session_id, started_at, ended_at, ended_reason,
         event_count, replay_chunk_count
       ) VALUES ($1, $2, $3, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET ended_at           = EXCLUDED.ended_at,
             ended_reason       = EXCLUDED.ended_reason,
             event_count        = COALESCE(EXCLUDED.event_count, sessions.event_count),
             replay_chunk_count = COALESCE(EXCLUDED.replay_chunk_count, sessions.replay_chunk_count),
             updated_at         = now()`,
      [
        tenantId,
        record.sessionId,
        record.endedAt,
        record.reason,
        record.eventCount ?? null,
        record.replayChunkCount ?? null,
      ]
    );
  }
}

// --- Repositories ------------------------------------------------------

interface SessionRow extends QueryResultRow {
  session_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  ended_reason: string | null;
  app_version: string | null;
  release_channel: string | null;
  user_anon_id: string | null;
  replay_chunk_count: number | null;
  client: unknown;
  event_count: string | number;
  support_code: string | null;
}

interface EventRow extends QueryResultRow {
  event_id: string;
  session_id: string | null;
  type: string;
  captured_at: Date | string;
  attributes: unknown;
  clock_skew_detected: boolean;
  schema_version: number | null;
  context: unknown;
  severity: string | null;
  duration_ms: number | null;
  http_status: number | null;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at == null ? null : toIso(row.ended_at),
    endedReason: row.ended_reason,
    appVersion: row.app_version,
    releaseChannel: row.release_channel,
    userAnonId: row.user_anon_id,
    eventCount:
      typeof row.event_count === "string"
        ? parseInt(row.event_count, 10)
        : row.event_count,
    replayChunkCount: row.replay_chunk_count,
    client: row.client ?? null,
    supportCode: row.support_code ?? null,
  };
}

function isSeverity(v: unknown): v is "info" | "warn" | "error" {
  return v === "info" || v === "warn" || v === "error";
}

function mapEvent(row: EventRow): EventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    capturedAt: toIso(row.captured_at),
    attributes:
      row.attributes == null
        ? null
        : (row.attributes as Record<string, unknown>),
    clockSkewDetected: row.clock_skew_detected,
    schemaVersion: row.schema_version ?? null,
    context:
      row.context == null ? null : (row.context as Record<string, unknown>),
    severity: isSeverity(row.severity) ? row.severity : null,
    durationMs: row.duration_ms ?? null,
    httpStatus: row.http_status ?? null,
  };
}

function encodeCursor(obj: Record<string, string>): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

function decodeCursor<T extends Record<string, string>>(
  raw: string | undefined
): T | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as T;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n) || n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

const SESSION_LIST_COLUMNS = `
  s.session_id,
  s.started_at,
  s.ended_at,
  s.ended_reason,
  s.app_version,
  s.release_channel,
  s.user_anon_id,
  s.replay_chunk_count,
  s.client,
  s.support_code,
  (SELECT COUNT(*) FROM events e
    WHERE e.tenant_id = s.tenant_id
      AND e.session_id = s.session_id) AS event_count
`;

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly pool: PgPool) {}

  async list(
    tenantId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ sessions: SessionRecord[]; nextCursor?: string }> {
    const limit = clamp(opts.limit || 50, 1, 200);
    const cursor = decodeCursor<{ startedAt: string; sessionId: string }>(
      opts.cursor
    );

    // Fetch `limit + 1` to decide whether a next page exists without an
    // extra COUNT() round-trip.
    const params: unknown[] = [tenantId];
    let whereCursor = "";
    if (cursor) {
      params.push(cursor.startedAt, cursor.sessionId);
      whereCursor = ` AND (s.started_at, s.session_id) < ($2, $3)`;
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const res = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_LIST_COLUMNS}
         FROM sessions s
        WHERE s.tenant_id = $1${whereCursor}
        ORDER BY s.started_at DESC, s.session_id DESC
        LIMIT ${limitParam}`,
      params
    );

    const rows = res.rows.slice(0, limit);
    const sessions = rows.map(mapSession);
    const hasMore = res.rows.length > limit;
    const last = sessions[sessions.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ startedAt: last.startedAt, sessionId: last.sessionId })
      : undefined;

    return nextCursor ? { sessions, nextCursor } : { sessions };
  }

  async get(
    tenantId: string,
    sessionId: string
  ): Promise<SessionRecord | null> {
    const res = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_LIST_COLUMNS}
         FROM sessions s
        WHERE s.tenant_id = $1
          AND s.session_id = $2`,
      [tenantId, sessionId]
    );
    const row = res.rows[0];
    return row ? mapSession(row) : null;
  }

  async findBySupportCode(
    tenantId: string,
    supportCode: string
  ): Promise<SessionRecord | null> {
    const res = await this.pool.query<SessionRow>(
      `SELECT ${SESSION_LIST_COLUMNS}
         FROM sessions s
        WHERE s.tenant_id = $1
          AND s.support_code = $2`,
      [tenantId, supportCode]
    );
    const row = res.rows[0];
    return row ? mapSession(row) : null;
  }
}

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: PgPool) {}

  async listBySession(
    tenantId: string,
    sessionId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ events: EventRecord[]; nextCursor?: string }> {
    const limit = clamp(opts.limit || 200, 1, 1000);
    const cursor = decodeCursor<{ capturedAt: string; eventId: string }>(
      opts.cursor
    );

    const params: unknown[] = [tenantId, sessionId];
    let whereCursor = "";
    if (cursor) {
      params.push(cursor.capturedAt, cursor.eventId);
      whereCursor = ` AND (captured_at, event_id) > ($3, $4)`;
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const res = await this.pool.query<EventRow>(
      `SELECT event_id, session_id, type, captured_at, attributes, clock_skew_detected,
              schema_version, context, severity, duration_ms, http_status
         FROM events
        WHERE tenant_id = $1
          AND session_id = $2${whereCursor}
        ORDER BY captured_at ASC, event_id ASC
        LIMIT ${limitParam}`,
      params
    );

    const rows = res.rows.slice(0, limit);
    const events = rows.map(mapEvent);
    const hasMore = res.rows.length > limit;
    const last = events[events.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ capturedAt: last.capturedAt, eventId: last.eventId })
      : undefined;

    return nextCursor ? { events, nextCursor } : { events };
  }
}

// --- Audit log ---------------------------------------------------------

interface AuditRow extends QueryResultRow {
  id: string | number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  occurred_at: Date | string;
  metadata: unknown;
}

function mapAudit(row: AuditRow): AuditRecord {
  return {
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    occurredAt: toIso(row.occurred_at),
    metadata:
      row.metadata == null ? null : (row.metadata as Record<string, unknown>),
  };
}

/**
 * Append-only audit sink. INSERT only — there is no update/delete surface
 * here, and the table's BEFORE UPDATE OR DELETE trigger (migration 004)
 * rejects mutation at the database level regardless.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: PgPool) {}

  async append(tenantId: string, record: AuditRecordInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (
         tenant_id, actor, action, target_type, target_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        record.actor,
        record.action,
        record.targetType ?? null,
        record.targetId ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      ]
    );
  }
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly pool: PgPool) {}

  async list(
    tenantId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ entries: AuditRecord[]; nextCursor?: string }> {
    const limit = clamp(opts.limit || 50, 1, 200);
    const cursor = decodeCursor<{ occurredAt: string; id: string }>(
      opts.cursor
    );

    const params: unknown[] = [tenantId];
    let whereCursor = "";
    if (cursor) {
      params.push(cursor.occurredAt, cursor.id);
      // Keyset pagination, newest first. `(occurred_at, id)` is unique enough
      // to break ties deterministically.
      whereCursor = ` AND (occurred_at, id) < ($2, $3)`;
    }
    params.push(limit + 1);
    const limitParam = `$${params.length}`;

    const res = await this.pool.query<AuditRow>(
      `SELECT id, actor, action, target_type, target_id, occurred_at, metadata
         FROM audit_log
        WHERE tenant_id = $1${whereCursor}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limitParam}`,
      params
    );

    const rows = res.rows.slice(0, limit);
    const entries = rows.map(mapAudit);
    const hasMore = res.rows.length > limit;
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            occurredAt: toIso(lastRow.occurred_at),
            id: String(lastRow.id),
          })
        : undefined;

    return nextCursor ? { entries, nextCursor } : { entries };
  }
}

// --- Settings ----------------------------------------------------------

/**
 * Postgres-backed key/value settings store (migration 005). Used to persist
 * admin overrides of the retention day-windows over the env defaults.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  constructor(private readonly pool: PgPool) {}

  async getAll(tenantId: string): Promise<Record<string, string>> {
    const res = await this.pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE tenant_id = $1",
      [tenantId]
    );
    const out: Record<string, string> = {};
    for (const row of res.rows) out[row.key] = row.value;
    return out;
  }

  async set(tenantId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO settings (tenant_id, key, value, updated_at)
         VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()`,
      [tenantId, key, value]
    );
  }
}

// --- Replay manifest ---------------------------------------------------

interface ReplayManifestRow extends QueryResultRow {
  session_id: string;
  sequence: number | string;
  key: string;
  bytes: number | string;
  sha256: string;
  scrubber: unknown;
  client_uploaded_at: Date | string | null;
  uploaded_at: Date | string;
}

function mapManifest(row: ReplayManifestRow): ReplayManifestRecord {
  return {
    sessionId: row.session_id,
    sequence:
      typeof row.sequence === "string"
        ? parseInt(row.sequence, 10)
        : row.sequence,
    key: row.key,
    bytes:
      typeof row.bytes === "string" ? parseInt(row.bytes, 10) : row.bytes,
    sha256: row.sha256,
    scrubber:
      row.scrubber == null ? null : (row.scrubber as ReplayScrubberReport),
    clientUploadedAt:
      row.client_uploaded_at == null ? null : toIso(row.client_uploaded_at),
    uploadedAt: toIso(row.uploaded_at),
  };
}

/**
 * Postgres-backed replay manifest store (migration 006). `recordChunk` inserts
 * the row and, only on a first-seen insert, increments
 * `sessions.replay_chunk_count` — both in one transaction so the counter and
 * the manifest never drift. A repeat for the same `(tenant, session, sequence)`
 * updates the row in place (refreshed bytes/sha/scrubber) and does NOT
 * re-increment.
 */
export class PostgresReplayManifestStore implements ReplayManifestStore {
  constructor(private readonly pool: PgPool) {}

  async recordChunk(
    tenantId: string,
    input: ReplayManifestInput
  ): Promise<{ inserted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // `xmax = 0` is true for a freshly-inserted row and false for a row that
      // an ON CONFLICT update touched — this distinguishes insert from update
      // without a second round-trip.
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO replay_manifest (
           tenant_id, session_id, sequence, key, bytes, sha256,
           scrubber, client_uploaded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, session_id, sequence) DO UPDATE
           SET key = EXCLUDED.key,
               bytes = EXCLUDED.bytes,
               sha256 = EXCLUDED.sha256,
               scrubber = EXCLUDED.scrubber,
               client_uploaded_at = EXCLUDED.client_uploaded_at
         RETURNING (xmax = 0) AS inserted`,
        [
          tenantId,
          input.sessionId,
          input.sequence,
          input.key,
          input.bytes,
          input.sha256,
          input.scrubber ? JSON.stringify(input.scrubber) : null,
          input.clientUploadedAt ?? null,
        ]
      );
      const inserted = res.rows[0]?.inserted === true;
      if (inserted) {
        // Bump the session counter. Upsert a minimal session row if the start
        // hasn't landed yet, so the count is never lost (LEAST keeps an earlier
        // explicit start if one arrives later).
        await client.query(
          `INSERT INTO sessions (tenant_id, session_id, started_at, replay_chunk_count)
             VALUES ($1, $2, now(), 1)
           ON CONFLICT (tenant_id, session_id) DO UPDATE
             SET replay_chunk_count = COALESCE(sessions.replay_chunk_count, 0) + 1,
                 updated_at = now()`,
          [tenantId, input.sessionId]
        );
      }
      await client.query("COMMIT");
      return { inserted };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listBySession(
    tenantId: string,
    sessionId: string
  ): Promise<ReplayManifestRecord[]> {
    const res = await this.pool.query<ReplayManifestRow>(
      `SELECT session_id, sequence, key, bytes, sha256,
              scrubber, client_uploaded_at, uploaded_at
         FROM replay_manifest
        WHERE tenant_id = $1 AND session_id = $2
        ORDER BY sequence ASC`,
      [tenantId, sessionId]
    );
    return res.rows.map(mapManifest);
  }
}

// --- Purge store -------------------------------------------------------

interface SessionReplayRow extends QueryResultRow {
  session_id: string;
  replay_chunk_count: number | string | null;
}

function toCount(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Postgres-backed purge + targeted-deletion store. All deletes are
 * tenant-scoped; the loop-style deletes use a bounded batch (via a
 * `ctid IN (... LIMIT n)` subselect) so a large purge never locks the table
 * for an unbounded span. Replay *objects* are not deleted here — the caller
 * (the purge runner) removes those via the storage adapter from the chunk
 * info returned alongside the row deletes.
 */
export class PostgresPurgeStore implements PurgeStore {
  constructor(private readonly pool: PgPool) {}

  async purgeEventsOlderThan(
    tenantId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const res = await this.pool.query(
        `DELETE FROM events
          WHERE ctid IN (
            SELECT ctid FROM events
             WHERE tenant_id = $1 AND captured_at < $2
             LIMIT $3
          )`,
        [tenantId, cutoff.toISOString(), batchSize]
      );
      const n = res.rowCount ?? 0;
      total += n;
      if (n < batchSize) break;
    }
    return total;
  }

  async listSessionsWithReplayOlderThan(
    tenantId: string,
    cutoff: Date,
    limit: number
  ): Promise<Array<{ sessionId: string; replayChunkCount: number }>> {
    const res = await this.pool.query<SessionReplayRow>(
      `SELECT session_id, replay_chunk_count
         FROM sessions
        WHERE tenant_id = $1
          AND started_at < $2
          AND replay_chunk_count IS NOT NULL
          AND replay_chunk_count > 0
        ORDER BY started_at ASC
        LIMIT $3`,
      [tenantId, cutoff.toISOString(), limit]
    );
    return res.rows.map((r) => ({
      sessionId: r.session_id,
      replayChunkCount: toCount(r.replay_chunk_count),
    }));
  }

  async clearReplayChunkCount(
    tenantId: string,
    sessionId: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE sessions
          SET replay_chunk_count = 0, updated_at = now()
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId]
    );
  }

  async listReplayManifestKeys(
    tenantId: string,
    sessionId: string
  ): Promise<string[]> {
    const res = await this.pool.query<{ key: string }>(
      `SELECT key FROM replay_manifest
        WHERE tenant_id = $1 AND session_id = $2
        ORDER BY sequence ASC`,
      [tenantId, sessionId]
    );
    return res.rows.map((r) => r.key);
  }

  async deleteReplayManifest(
    tenantId: string,
    sessionId: string
  ): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM replay_manifest
        WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId]
    );
    return res.rowCount ?? 0;
  }

  async purgeSessionsOlderThan(
    tenantId: string,
    cutoff: Date,
    batchSize: number
  ): Promise<{
    sessionsDeleted: number;
    eventsDeleted: number;
    replayChunks: Array<{ sessionId: string; replayChunkCount: number }>;
  }> {
    let sessionsDeleted = 0;
    let eventsDeleted = 0;
    const replayChunks: Array<{ sessionId: string; replayChunkCount: number }> =
      [];

    for (;;) {
      const client = await this.pool.connect();
      let batchCount = 0;
      try {
        await client.query("BEGIN");
        // Select a bounded batch of aged sessions, locking them so a
        // concurrent purge can't grab the same rows.
        const picked = await client.query<SessionReplayRow>(
          `SELECT session_id, replay_chunk_count
             FROM sessions
            WHERE tenant_id = $1 AND started_at < $2
            ORDER BY started_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED`,
          [tenantId, cutoff.toISOString(), batchSize]
        );
        batchCount = picked.rows.length;
        if (batchCount === 0) {
          await client.query("COMMIT");
          break;
        }
        const ids = picked.rows.map((r) => r.session_id);
        // Cascade: delete this batch's events first, then the sessions.
        const evRes = await client.query(
          `DELETE FROM events
            WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
          [tenantId, ids]
        );
        eventsDeleted += evRes.rowCount ?? 0;
        const sRes = await client.query(
          `DELETE FROM sessions
            WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
          [tenantId, ids]
        );
        sessionsDeleted += sRes.rowCount ?? 0;
        for (const r of picked.rows) {
          const count = toCount(r.replay_chunk_count);
          if (count > 0) {
            replayChunks.push({
              sessionId: r.session_id,
              replayChunkCount: count,
            });
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (batchCount < batchSize) break;
    }

    return { sessionsDeleted, eventsDeleted, replayChunks };
  }

  async deleteSession(
    tenantId: string,
    sessionId: string
  ): Promise<{
    found: boolean;
    eventsDeleted: number;
    replayChunkCount: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the session row (if any) so the cascade is consistent.
      const sel = await client.query<SessionReplayRow>(
        `SELECT session_id, replay_chunk_count
           FROM sessions
          WHERE tenant_id = $1 AND session_id = $2
          FOR UPDATE`,
        [tenantId, sessionId]
      );
      const row = sel.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { found: false, eventsDeleted: 0, replayChunkCount: 0 };
      }
      const replayChunkCount = toCount(row.replay_chunk_count);
      const evRes = await client.query(
        `DELETE FROM events WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId]
      );
      await client.query(
        `DELETE FROM sessions WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId]
      );
      await client.query("COMMIT");
      return {
        found: true,
        eventsDeleted: evRes.rowCount ?? 0,
        replayChunkCount,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
