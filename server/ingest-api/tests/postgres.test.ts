/**
 * Unit tests for the Postgres-backed sinks, repositories, and migration
 * runner.
 *
 * No real Postgres — every test uses a hand-rolled fake that records SQL
 * calls and returns canned row sets. The repository/sink code depends only
 * on the minimal `PgPool` interface, so the real `pg.Pool` and the fake
 * both typecheck the same way.
 */

import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  PostgresEventRepository,
  PostgresEventSink,
  PostgresSessionRepository,
  PostgresSessionSink,
  runMigrations,
  type PgClient,
  type PgPool,
} from "../postgres.js";
import { ValidatedEvent } from "../types.js";

interface RecordedQuery {
  text: string;
  params: unknown[] | undefined;
}

type Responder = (
  text: string,
  params: unknown[] | undefined
) => QueryResult<QueryResultRow> | undefined;

function ok<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  };
}

class FakePool implements PgPool {
  readonly queries: RecordedQuery[] = [];
  readonly clientQueries: RecordedQuery[] = [];
  private readonly respond: Responder;

  constructor(respond: Responder = () => undefined) {
    this.respond = respond;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> {
    this.queries.push({ text, params });
    const res = this.respond(text, params) as QueryResult<R> | undefined;
    return res ?? ok<R>([]);
  }

  async connect(): Promise<PgClient> {
    const parent = this;
    const client: PgClient = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> {
        parent.clientQueries.push({ text, params });
        const res = parent.respond(text, params) as QueryResult<R> | undefined;
        return res ?? ok<R>([]);
      },
      release(): void {
        // no-op
      },
    };
    return client;
  }

  async end(): Promise<void> {
    // no-op
  }
}

describe("runMigrations", () => {
  it("is idempotent — second run applies nothing", async () => {
    // Pretend every listed migration has already been applied.
    const applied = new Set<string>(["001_init"]);
    const pool = new FakePool((text, params) => {
      const sql = text.trim().toUpperCase();
      if (sql.startsWith("SELECT VERSION")) {
        return ok(Array.from(applied).map((v) => ({ version: v })));
      }
      if (sql.startsWith("INSERT INTO SCHEMA_MIGRATIONS")) {
        applied.add(String(params?.[0]));
        return ok([]);
      }
      return undefined;
    });

    await runMigrations(pool);
    const first = pool.clientQueries.length;

    await runMigrations(pool);
    const second = pool.clientQueries.length;

    // No client-side (transactional) statements on the second run.
    expect(second).toBe(first);
  });

  it("applies unseen migrations in a transaction", async () => {
    const applied = new Set<string>();
    const pool = new FakePool((text, params) => {
      const sql = text.trim().toUpperCase();
      if (sql.startsWith("SELECT VERSION")) {
        return ok(Array.from(applied).map((v) => ({ version: v })));
      }
      if (sql.startsWith("INSERT INTO SCHEMA_MIGRATIONS")) {
        applied.add(String(params?.[0]));
        return ok([]);
      }
      return undefined;
    });

    await runMigrations(pool);

    const clientSql = pool.clientQueries.map((q) => q.text.trim());
    // Each applied version should be wrapped in BEGIN/COMMIT.
    expect(clientSql).toContain("BEGIN");
    expect(clientSql).toContain("COMMIT");
    // The 001_init migration must have been recorded.
    expect(applied.has("001_init")).toBe(true);
  });
});

function makeEvent(overrides: Partial<ValidatedEvent> = {}): ValidatedEvent {
  return {
    eventId: "evt-1",
    sessionId: "sess-1",
    type: "page_view",
    capturedAt: "2026-04-20T12:00:00.000Z",
    scrubber: {
      version: "sdk@0.1.0",
      rulesDigest: "sha256:deadbeef",
      applied: [],
      budgetExceeded: false,
    },
    sdk: { name: "@peaktek/resolvetrace-sdk", version: "0.1.0" },
    ...overrides,
  };
}

describe("PostgresEventSink", () => {
  it("inserts events and upserts a session row per sessionId", async () => {
    const pool = new FakePool();
    const sink = new PostgresEventSink(pool);
    await sink.enqueue("tenant-1", [makeEvent()]);

    const sqls = pool.clientQueries.map((q) => q.text);
    expect(sqls.some((s) => /BEGIN/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO events/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO sessions/.test(s))).toBe(true);
    expect(sqls.some((s) => /COMMIT/.test(s))).toBe(true);

    // The session upsert must use LEAST so a later event can't bump
    // started_at forward.
    const sessionUpsert = sqls.find((s) => /INSERT INTO sessions/.test(s))!;
    expect(sessionUpsert).toMatch(/LEAST\(/);
  });

  it("skips the session upsert for events without a sessionId", async () => {
    const pool = new FakePool();
    const sink = new PostgresEventSink(pool);
    await sink.enqueue("tenant-1", [makeEvent({ sessionId: undefined })]);

    const sqls = pool.clientQueries.map((q) => q.text);
    expect(sqls.some((s) => /INSERT INTO events/.test(s))).toBe(true);
    expect(sqls.every((s) => !/INSERT INTO sessions/.test(s))).toBe(true);
  });

  it("event insert uses ON CONFLICT DO NOTHING for idempotency", async () => {
    const pool = new FakePool();
    const sink = new PostgresEventSink(pool);
    await sink.enqueue("tenant-1", [makeEvent()]);

    const eventInsert = pool.clientQueries
      .map((q) => q.text)
      .find((s) => /INSERT INTO events/.test(s))!;
    expect(eventInsert).toMatch(/ON CONFLICT \(tenant_id, event_id\) DO NOTHING/);
  });

  it("rolls back the transaction when a query fails", async () => {
    const pool = new FakePool((text) => {
      if (/INSERT INTO events/.test(text)) throw new Error("boom");
      return undefined;
    });
    const sink = new PostgresEventSink(pool);
    await expect(sink.enqueue("tenant-1", [makeEvent()])).rejects.toThrow("boom");
    const sqls = pool.clientQueries.map((q) => q.text);
    expect(sqls).toContain("ROLLBACK");
  });
});

describe("PostgresSessionSink", () => {
  it("recordStart upserts all fields with LEAST started_at", async () => {
    const pool = new FakePool();
    const sink = new PostgresSessionSink(pool);
    await sink.recordStart("tenant-1", {
      sessionId: "sess-1",
      startedAt: "2026-04-20T12:00:00.000Z",
      appVersion: "1.0.0",
      releaseChannel: "stable",
      userAnonId: "anon-1",
      client: { ua: "test" },
    });
    const q = pool.queries[0];
    expect(q).toBeDefined();
    expect(q!.text).toMatch(/INSERT INTO sessions/);
    expect(q!.text).toMatch(/LEAST\(/);
  });

  it("recordEnd upserts a minimal row when no session exists", async () => {
    const pool = new FakePool();
    const sink = new PostgresSessionSink(pool);
    await sink.recordEnd("tenant-1", {
      sessionId: "sess-99",
      endedAt: "2026-04-20T13:00:00.000Z",
      reason: "closed",
    });
    const q = pool.queries[0];
    expect(q).toBeDefined();
    // When the sessions row doesn't exist, the INSERT lane fires with
    // `started_at = ended_at` so the session shows up in listings.
    expect(q!.text).toMatch(/INSERT INTO sessions/);
    expect(q!.text).toMatch(/ON CONFLICT \(tenant_id, session_id\) DO UPDATE/);
  });
});

describe("PostgresSessionRepository", () => {
  it("list orders by started_at DESC and emits a cursor when more remain", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) {
        // Return limit+1 rows to trigger hasMore.
        const rows = Array.from({ length: 3 }, (_, i) => ({
          session_id: `s-${i}`,
          started_at: new Date(`2026-04-20T12:0${i}:00.000Z`),
          ended_at: null,
          ended_reason: null,
          app_version: null,
          release_channel: null,
          user_anon_id: null,
          replay_chunk_count: null,
          client: null,
          event_count: i,
        }));
        return ok(rows);
      }
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const result = await repo.list("tenant-1", { limit: 2 });
    expect(result.sessions).toHaveLength(2);
    expect(result.nextCursor).toBeDefined();

    const sql = pool.queries[0]!.text;
    expect(sql).toMatch(/ORDER BY s\.started_at DESC, s\.session_id DESC/);
    expect(sql).toMatch(/SELECT COUNT\(\*\) FROM events/);
  });

  it("list returns no cursor when results fit in one page", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) {
        return ok([
          {
            session_id: "s-0",
            started_at: "2026-04-20T12:00:00.000Z",
            ended_at: null,
            ended_reason: null,
            app_version: null,
            release_channel: null,
            user_anon_id: null,
            replay_chunk_count: null,
            client: null,
            event_count: "0",
          },
        ]);
      }
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const result = await repo.list("tenant-1", { limit: 50 });
    expect(result.sessions).toHaveLength(1);
    expect(result.nextCursor).toBeUndefined();
    expect(result.sessions[0]!.eventCount).toBe(0);
  });

  it("list accepts an opaque cursor", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) return ok([]);
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const cursor = Buffer.from(
      JSON.stringify({ startedAt: "2026-04-20T12:00:00.000Z", sessionId: "s-0" })
    ).toString("base64");
    await repo.list("tenant-1", { limit: 10, cursor });
    const q = pool.queries[0]!;
    expect(q.text).toMatch(/\(s\.started_at, s\.session_id\) < \(\$2, \$3\)/);
    expect(q.params?.[1]).toBe("2026-04-20T12:00:00.000Z");
    expect(q.params?.[2]).toBe("s-0");
  });

  it("list clamps limit into [1, 200]", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) return ok([]);
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    await repo.list("tenant-1", { limit: 999 });
    const q = pool.queries[0]!;
    // limit is appended as the last numeric param; hasMore uses limit+1.
    const params = q.params ?? [];
    expect(params[params.length - 1]).toBe(201);
  });

  it("get returns null when no row found", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) return ok([]);
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const result = await repo.get("tenant-1", "missing");
    expect(result).toBeNull();
  });
});

describe("PostgresEventRepository", () => {
  it("listBySession orders ASC and uses forward cursor", async () => {
    const pool = new FakePool((text) => {
      if (/FROM events/.test(text)) {
        return ok([
          {
            event_id: "e-0",
            session_id: "s-0",
            type: "page_view",
            captured_at: "2026-04-20T12:00:00.000Z",
            attributes: { x: 1 },
            clock_skew_detected: false,
          },
        ]);
      }
      return undefined;
    });
    const repo = new PostgresEventRepository(pool);
    const result = await repo.listBySession("tenant-1", "s-0", { limit: 50 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.attributes).toEqual({ x: 1 });
    const sql = pool.queries[0]!.text;
    expect(sql).toMatch(/ORDER BY captured_at ASC, event_id ASC/);
  });
});
