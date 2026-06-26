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
  PostgresAuditRepository,
  PostgresAuditSink,
  PostgresEventRepository,
  PostgresEventSink,
  PostgresPurgeStore,
  PostgresReplayManifestStore,
  PostgresSessionRepository,
  PostgresSessionSink,
  PostgresSettingsRepository,
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
    schemaVersion: 1,
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
    const pool = new FakePool((text) => {
      // The support-code mint runs after the upsert; echo a canned code so
      // recordStart resolves.
      if (/UPDATE sessions/.test(text) && /support_code/.test(text)) {
        return ok([{ support_code: "ABCD1234" }]);
      }
      return undefined;
    });
    const sink = new PostgresSessionSink(pool);
    const result = await sink.recordStart("tenant-1", {
      sessionId: "sess-1",
      startedAt: "2026-04-20T12:00:00.000Z",
      appVersion: "1.0.0",
      releaseChannel: "stable",
      userAnonId: "anon-1",
      client: { ua: "test" },
    });
    expect(result.supportCode).toBe("ABCD1234");
    const q = pool.queries[0];
    expect(q).toBeDefined();
    expect(q!.text).toMatch(/INSERT INTO sessions/);
    expect(q!.text).toMatch(/LEAST\(/);
  });

  it("recordStart mints a support code via COALESCE and returns it", async () => {
    const pool = new FakePool((text) => {
      if (/UPDATE sessions/.test(text) && /support_code/.test(text)) {
        // COALESCE(support_code, $3) — first start has no prior code, so the
        // candidate ($3) is written. The fake echoes a canned canonical code.
        return ok([{ support_code: "ABCD1234" }]);
      }
      return undefined;
    });
    const sink = new PostgresSessionSink(pool);
    const result = await sink.recordStart("tenant-1", {
      sessionId: "sess-1",
      startedAt: "2026-04-20T12:00:00.000Z",
    });
    expect(result.supportCode).toBe("ABCD1234");

    const mintSql = pool.queries.map((q) => q.text).find((s) =>
      /UPDATE sessions/.test(s) && /support_code/.test(s)
    )!;
    // Idempotent: keeps any existing code, only fills NULL.
    expect(mintSql).toMatch(/COALESCE\(support_code/);
    expect(mintSql).toMatch(/RETURNING support_code/);
  });

  it("recordStart retries generation on a unique-index collision", async () => {
    let attempts = 0;
    const pool = new FakePool((text) => {
      if (/UPDATE sessions/.test(text) && /support_code/.test(text)) {
        attempts++;
        if (attempts === 1) {
          // Simulate the partial unique index rejecting a duplicate code.
          const err = new Error("duplicate key") as Error & { code: string };
          err.code = "23505";
          throw err;
        }
        return ok([{ support_code: "ZZZZ9999" }]);
      }
      return undefined;
    });
    const sink = new PostgresSessionSink(pool);
    const result = await sink.recordStart("tenant-1", {
      sessionId: "sess-2",
      startedAt: "2026-04-20T12:00:00.000Z",
    });
    expect(attempts).toBe(2);
    expect(result.supportCode).toBe("ZZZZ9999");
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

  it("findBySupportCode filters on tenant_id + support_code", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text) && /support_code = \$2/.test(text)) {
        return ok([
          {
            session_id: "s-7",
            started_at: "2026-04-20T12:00:00.000Z",
            ended_at: null,
            ended_reason: null,
            app_version: null,
            release_channel: null,
            user_anon_id: null,
            replay_chunk_count: null,
            client: null,
            event_count: "0",
            support_code: "ABCD1234",
          },
        ]);
      }
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const result = await repo.findBySupportCode("tenant-1", "ABCD1234");
    expect(result?.sessionId).toBe("s-7");
    expect(result?.supportCode).toBe("ABCD1234");
    const q = pool.queries[0]!;
    expect(q.params).toEqual(["tenant-1", "ABCD1234"]);
  });

  it("findBySupportCode returns null when no row matches", async () => {
    const pool = new FakePool((text) => {
      if (/FROM sessions/.test(text)) return ok([]);
      return undefined;
    });
    const repo = new PostgresSessionRepository(pool);
    const result = await repo.findBySupportCode("tenant-1", "NOPE0000");
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

describe("PostgresAuditSink", () => {
  it("issues a single INSERT into audit_log with serialized metadata", async () => {
    const pool = new FakePool();
    const sink = new PostgresAuditSink(pool);
    await sink.append("tenant-1", {
      actor: "portal-service:jti",
      action: "session.view",
      targetType: "session",
      targetId: "s-1",
      metadata: { result: "hit" },
    });
    expect(pool.queries).toHaveLength(1);
    const q = pool.queries[0]!;
    expect(q.text).toMatch(/INSERT INTO audit_log/);
    expect(q.text).not.toMatch(/UPDATE|DELETE/i);
    expect(q.params).toEqual([
      "tenant-1",
      "portal-service:jti",
      "session.view",
      "session",
      "s-1",
      JSON.stringify({ result: "hit" }),
    ]);
  });

  it("passes null metadata through as null (not the string 'null')", async () => {
    const pool = new FakePool();
    const sink = new PostgresAuditSink(pool);
    await sink.append("tenant-1", { actor: "a", action: "auth.login" });
    expect(pool.queries[0]!.params![5]).toBeNull();
  });
});

describe("PostgresAuditRepository", () => {
  it("orders newest-first and emits a next cursor when a page is full", async () => {
    const pool = new FakePool((text) => {
      if (/FROM audit_log/.test(text)) {
        return ok([
          {
            id: 2,
            actor: "a",
            action: "session.view",
            target_type: "session",
            target_id: "s-2",
            occurred_at: "2026-04-20T12:02:00.000Z",
            metadata: { result: "hit" },
          },
          {
            id: 1,
            actor: "a",
            action: "auth.login",
            target_type: null,
            target_id: null,
            occurred_at: "2026-04-20T12:01:00.000Z",
            metadata: null,
          },
        ]);
      }
      return undefined;
    });
    const repo = new PostgresAuditRepository(pool);
    // limit 1 => repo fetches limit+1 (=2), so hasMore is true and a cursor
    // is returned.
    const result = await repo.list("tenant-1", { limit: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.action).toBe("session.view");
    expect(result.nextCursor).toBeDefined();
    const sql = pool.queries[0]!.text;
    expect(sql).toMatch(/ORDER BY occurred_at DESC, id DESC/);
  });

  it("applies a keyset cursor predicate when a cursor is supplied", async () => {
    const pool = new FakePool(() => ok([]));
    const repo = new PostgresAuditRepository(pool);
    const cursor = Buffer.from(
      JSON.stringify({ occurredAt: "2026-04-20T12:00:00.000Z", id: "5" }),
      "utf8"
    ).toString("base64");
    await repo.list("tenant-1", { limit: 50, cursor });
    const sql = pool.queries[0]!.text;
    expect(sql).toMatch(/\(occurred_at, id\) < \(\$2, \$3\)/);
  });
});

// --- Settings + purge store -------------------------------------------

function okCount<R extends QueryResultRow>(
  rows: R[],
  rowCount: number
): QueryResult<R> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

describe("PostgresSettingsRepository", () => {
  it("reads all settings for a tenant as a key->value map", async () => {
    const pool = new FakePool((text) =>
      /SELECT key, value FROM settings/.test(text)
        ? ok([
            { key: "retention.events_days", value: "7" },
            { key: "retention.replay_days", value: "3" },
          ])
        : undefined
    );
    const repo = new PostgresSettingsRepository(pool);
    const all = await repo.getAll("t1");
    expect(all).toEqual({
      "retention.events_days": "7",
      "retention.replay_days": "3",
    });
  });

  it("upserts a setting via ON CONFLICT DO UPDATE", async () => {
    const pool = new FakePool(() => undefined);
    const repo = new PostgresSettingsRepository(pool);
    await repo.set("t1", "retention.events_days", "14");
    const q = pool.queries[0]!;
    expect(q.text).toMatch(/INSERT INTO settings/);
    expect(q.text).toMatch(/ON CONFLICT \(tenant_id, key\) DO UPDATE/);
    expect(q.params).toEqual(["t1", "retention.events_days", "14"]);
  });
});

describe("PostgresPurgeStore", () => {
  it("purgeEventsOlderThan loops bounded batches until under the batch size", async () => {
    let call = 0;
    const pool = new FakePool((text) => {
      if (!/DELETE FROM events/.test(text)) return undefined;
      call += 1;
      // First full batch (3), then a short final batch (1) ends the loop.
      return call === 1 ? okCount([], 3) : okCount([], 1);
    });
    const store = new PostgresPurgeStore(pool);
    const deleted = await store.purgeEventsOlderThan(
      "t1",
      new Date("2026-01-01T00:00:00Z"),
      3
    );
    expect(deleted).toBe(4);
    expect(call).toBe(2);
    // Bounded-batch via ctid subselect with LIMIT.
    expect(pool.queries[0]!.text).toMatch(/ctid IN/);
    expect(pool.queries[0]!.text).toMatch(/LIMIT \$3/);
  });

  it("deleteSession cascades events then session and returns the replay count", async () => {
    const pool = new FakePool((text) => {
      if (/SELECT session_id, replay_chunk_count/.test(text)) {
        return ok([{ session_id: "s1", replay_chunk_count: 2 }]);
      }
      if (/DELETE FROM events/.test(text)) return okCount([], 5);
      return undefined;
    });
    const store = new PostgresPurgeStore(pool);
    const res = await store.deleteSession("t1", "s1");
    expect(res).toEqual({ found: true, eventsDeleted: 5, replayChunkCount: 2 });
    // Cascade order: BEGIN, SELECT ... FOR UPDATE, DELETE events, DELETE session, COMMIT.
    const ops = pool.clientQueries.map((q) =>
      q.text.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase()
    );
    expect(ops).toContain("DELETE FROM"); // events + session
    expect(pool.clientQueries.some((q) => /DELETE FROM events/.test(q.text))).toBe(true);
    expect(pool.clientQueries.some((q) => /DELETE FROM sessions/.test(q.text))).toBe(true);
  });

  it("deleteSession returns found=false for an unknown session (idempotent)", async () => {
    const pool = new FakePool((text) =>
      /SELECT session_id, replay_chunk_count/.test(text) ? ok([]) : undefined
    );
    const store = new PostgresPurgeStore(pool);
    const res = await store.deleteSession("t1", "missing");
    expect(res).toEqual({ found: false, eventsDeleted: 0, replayChunkCount: 0 });
    // No DELETE issued when the session doesn't exist.
    expect(pool.clientQueries.some((q) => /DELETE/.test(q.text))).toBe(false);
  });

  it("listSessionsWithReplayOlderThan filters on count>0 and the cutoff", async () => {
    const pool = new FakePool((text) =>
      /FROM sessions/.test(text)
        ? ok([{ session_id: "s1", replay_chunk_count: 4 }])
        : undefined
    );
    const store = new PostgresPurgeStore(pool);
    const rows = await store.listSessionsWithReplayOlderThan(
      "t1",
      new Date("2026-01-01T00:00:00Z"),
      100
    );
    expect(rows).toEqual([{ sessionId: "s1", replayChunkCount: 4 }]);
    expect(pool.queries[0]!.text).toMatch(/replay_chunk_count > 0/);
    expect(pool.queries[0]!.text).toMatch(/started_at < \$2/);
  });
});

describe("PostgresReplayManifestStore", () => {
  it("inserts the row and increments the counter on a first-seen chunk", async () => {
    const pool = new FakePool((text) => {
      if (text.includes("INSERT INTO replay_manifest")) {
        return ok([{ inserted: true }]);
      }
      return undefined;
    });
    const store = new PostgresReplayManifestStore(pool);
    const res = await store.recordChunk("t", {
      sessionId: "s",
      sequence: 0,
      key: "t/s/0.rrweb",
      bytes: 1024,
      sha256: "a".repeat(64),
      scrubber: {
        version: "sdk@0.1.0",
        rulesDigest: "sha256:" + "b".repeat(64),
        applied: [],
        budgetExceeded: false,
      },
      clientUploadedAt: "2026-04-20T12:35:00.000Z",
    });
    expect(res.inserted).toBe(true);

    const sqls = pool.clientQueries.map((q) => q.text);
    expect(sqls.some((s) => s.includes("INSERT INTO replay_manifest"))).toBe(true);
    // First-seen => the session counter increment runs.
    expect(
      sqls.some((s) => s.includes("replay_chunk_count = COALESCE"))
    ).toBe(true);
    expect(sqls.some((s) => s.includes("COMMIT"))).toBe(true);
  });

  it("does NOT increment the counter on a repeated sequence (ON CONFLICT update)", async () => {
    const pool = new FakePool((text) => {
      if (text.includes("INSERT INTO replay_manifest")) {
        return ok([{ inserted: false }]);
      }
      return undefined;
    });
    const store = new PostgresReplayManifestStore(pool);
    const res = await store.recordChunk("t", {
      sessionId: "s",
      sequence: 0,
      key: "t/s/0.rrweb",
      bytes: 1024,
      sha256: "a".repeat(64),
    });
    expect(res.inserted).toBe(false);
    const sqls = pool.clientQueries.map((q) => q.text);
    // No counter increment when the row already existed.
    expect(
      sqls.some((s) => s.includes("replay_chunk_count = COALESCE"))
    ).toBe(false);
  });

  it("listBySession maps rows in sequence order", async () => {
    const pool = new FakePool((text) => {
      if (text.includes("FROM replay_manifest")) {
        return ok([
          {
            session_id: "s",
            sequence: 0,
            key: "t/s/0.rrweb",
            bytes: 1024,
            sha256: "a".repeat(64),
            scrubber: { version: "sdk@0.1.0" },
            client_uploaded_at: "2026-04-20T12:35:00.000Z",
            uploaded_at: "2026-04-20T12:35:01.000Z",
          },
        ]);
      }
      return undefined;
    });
    const store = new PostgresReplayManifestStore(pool);
    const rows = await store.listBySession("t", "s");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("t/s/0.rrweb");
    expect(rows[0]!.bytes).toBe(1024);
    expect(rows[0]!.scrubber).toMatchObject({ version: "sdk@0.1.0" });
  });
});

describe("PostgresPurgeStore — replay manifest sweep (Wave-24)", () => {
  it("listReplayManifestKeys returns the keys in sequence order", async () => {
    const pool = new FakePool((text) => {
      if (text.includes("SELECT key FROM replay_manifest")) {
        return ok([{ key: "t/s/0.rrweb" }, { key: "t/s/1.rrweb" }]);
      }
      return undefined;
    });
    const store = new PostgresPurgeStore(pool);
    expect(await store.listReplayManifestKeys("t", "s")).toEqual([
      "t/s/0.rrweb",
      "t/s/1.rrweb",
    ]);
  });

  it("deleteReplayManifest returns the deleted row count", async () => {
    const pool = new FakePool((text) => {
      if (text.includes("DELETE FROM replay_manifest")) {
        return { rows: [], rowCount: 3, command: "", oid: 0, fields: [] };
      }
      return undefined;
    });
    const store = new PostgresPurgeStore(pool);
    expect(await store.deleteReplayManifest("t", "s")).toBe(3);
  });
});
