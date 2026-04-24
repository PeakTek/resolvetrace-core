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
  EventRecord,
  EventRepository,
  EventSink,
  SessionEndRecord,
  SessionRecord,
  SessionRepository,
  SessionSink,
  SessionStartRecord,
  ValidatedEvent,
} from "./types.js";

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

export class PostgresEventSink implements EventSink {
  constructor(private readonly pool: PgPool) {}

  async enqueue(
    tenantId: string,
    events: ReadonlyArray<ValidatedEvent>
  ): Promise<void> {
    if (events.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const evt of events) {
        await client.query(
          `INSERT INTO events (
             tenant_id, event_id, session_id, type, captured_at,
             attributes, scrubber, sdk, clock_skew_detected
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          ]
        );
        if (evt.sessionId) {
          // Derive a minimal session row on first-seen — keeps listings
          // correct even when the SDK never calls /session/start.
          // `started_at` uses LEAST semantics so an earlier explicit start
          // still wins.
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

  async recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (
         tenant_id, session_id, started_at,
         app_version, release_channel, user_anon_id, client
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET started_at      = LEAST(sessions.started_at, EXCLUDED.started_at),
             app_version     = COALESCE(EXCLUDED.app_version, sessions.app_version),
             release_channel = COALESCE(EXCLUDED.release_channel, sessions.release_channel),
             user_anon_id    = COALESCE(EXCLUDED.user_anon_id, sessions.user_anon_id),
             client          = COALESCE(EXCLUDED.client, sessions.client),
             updated_at      = now()`,
      [
        tenantId,
        record.sessionId,
        record.startedAt,
        record.appVersion ?? null,
        record.releaseChannel ?? null,
        record.userAnonId ?? null,
        record.client !== undefined ? JSON.stringify(record.client) : null,
      ]
    );
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
}

interface EventRow extends QueryResultRow {
  event_id: string;
  session_id: string | null;
  type: string;
  captured_at: Date | string;
  attributes: unknown;
  clock_skew_detected: boolean;
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
  };
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
      `SELECT event_id, session_id, type, captured_at, attributes, clock_skew_detected
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
