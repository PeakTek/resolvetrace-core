/**
 * End-to-end tests for the strict-session ingest path: events with a
 * `session_id` that does not resolve in the `sessions` table for the tenant
 * are rejected with HTTP 409 and the `session_unknown` envelope; events
 * missing `session_id` under strict mode are rejected with HTTP 400 and the
 * `session_required` envelope. The default lenient mode is also exercised
 * to confirm the existing auto-derive behavior is preserved.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresEventSink, type PgClient, type PgPool } from "../postgres.js";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  AUTH_HEADER,
  validBatch,
  validEvent,
  VALID_ULID_A,
  VALID_ULID_B,
  VALID_ULID_SESSION,
} from "../test-utils/fixtures.js";

const VALID_ULID_SESSION_B = "01HXA0C4YFGJXQZ2P3R4T5V6WE";
const TENANT = "oss-test-tenant";

interface RecordedQuery {
  text: string;
  params: unknown[] | undefined;
}

function ok<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    rows,
    rowCount: rows.length,
    command: "",
    oid: 0,
    fields: [],
  };
}

/**
 * Fake `PgPool` that simulates a `sessions` table. Tests pre-populate the
 * `knownSessions` set; `SELECT session_id FROM sessions WHERE ...` is
 * resolved against that set, and event/session inserts are recorded for
 * later inspection.
 */
class FakeSessionPool implements PgPool {
  readonly clientQueries: RecordedQuery[] = [];
  readonly poolQueries: RecordedQuery[] = [];
  readonly knownSessions = new Set<string>();
  readonly insertedEventIds = new Set<string>();

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> {
    this.poolQueries.push({ text, params });
    if (/SELECT session_id FROM sessions/i.test(text)) {
      const tenantId = String(params?.[0]);
      const ids = (params?.[1] as string[]) ?? [];
      const rows = ids
        .filter((id) => this.knownSessions.has(`${tenantId}:${id}`))
        .map((id) => ({ session_id: id }));
      return ok(rows) as unknown as QueryResult<R>;
    }
    return ok([]) as unknown as QueryResult<R>;
  }

  async connect(): Promise<PgClient> {
    const parent = this;
    const client: PgClient = {
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[]
      ): Promise<QueryResult<R>> {
        parent.clientQueries.push({ text, params });
        if (/INSERT INTO events/i.test(text) && params) {
          parent.insertedEventIds.add(String(params[1]));
        }
        return ok([]) as unknown as QueryResult<R>;
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

describe("POST /v1/events — strict-session mode", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("strict off (default): event with new session_id auto-derives, returns 202", async () => {
    const pool = new FakeSessionPool();
    const eventSink = new PostgresEventSink(pool);
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ sessionId: VALID_ULID_SESSION }),
      ]),
    });

    expect(res.statusCode).toBe(202);
    expect(pool.insertedEventIds.has(VALID_ULID_A)).toBe(true);
    // Auto-derive issues an INSERT INTO sessions for the unseen id.
    expect(
      pool.clientQueries.some((q) => /INSERT INTO sessions/i.test(q.text))
    ).toBe(true);
  });

  it("strict on, all session_ids resolve: returns 202 and inserts events", async () => {
    const pool = new FakeSessionPool();
    pool.knownSessions.add(`${TENANT}:${VALID_ULID_SESSION}`);
    const eventSink = new PostgresEventSink(pool, { strictSessions: true });
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ sessionId: VALID_ULID_SESSION }),
      ]),
    });

    expect(res.statusCode).toBe(202);
    expect(pool.insertedEventIds.has(VALID_ULID_A)).toBe(true);
    // No auto-derive in strict mode — the row already existed.
    expect(
      pool.clientQueries.every((q) => !/INSERT INTO sessions/i.test(q.text))
    ).toBe(true);
  });

  it("strict on, one unresolved session_id: returns 409 envelope and inserts no events", async () => {
    const pool = new FakeSessionPool();
    // None of the requested ids are pre-registered.
    const eventSink = new PostgresEventSink(pool, { strictSessions: true });
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ sessionId: VALID_ULID_SESSION }),
      ]),
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("session_unknown");
    expect(body.unresolved_session_ids).toEqual([VALID_ULID_SESSION]);
    expect(typeof body.message).toBe("string");
    // No event insert ran — the resolution check failed before BEGIN.
    expect(pool.insertedEventIds.size).toBe(0);
    expect(
      pool.clientQueries.every((q) => !/INSERT INTO events/i.test(q.text))
    ).toBe(true);
  });

  it("strict on, multiple unresolved session_ids: 409 lists all distinct ids", async () => {
    const pool = new FakeSessionPool();
    const eventSink = new PostgresEventSink(pool, { strictSessions: true });
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ eventId: VALID_ULID_A, sessionId: VALID_ULID_SESSION }),
        validEvent({ eventId: VALID_ULID_B, sessionId: VALID_ULID_SESSION_B }),
      ]),
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("session_unknown");
    expect(new Set(body.unresolved_session_ids)).toEqual(
      new Set([VALID_ULID_SESSION, VALID_ULID_SESSION_B])
    );
  });

  it("strict on, session_id missing: returns 400 session_required, no events inserted", async () => {
    const pool = new FakeSessionPool();
    const eventSink = new PostgresEventSink(pool, { strictSessions: true });
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      // No sessionId on the event.
      payload: validBatch([validEvent()]),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("session_required");
    expect(typeof body.message).toBe("string");
    expect(pool.insertedEventIds.size).toBe(0);
  });

  it("strict on, recovery: same batch retries cleanly after the session is registered", async () => {
    const pool = new FakeSessionPool();
    const eventSink = new PostgresEventSink(pool, { strictSessions: true });
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    // First call — session not yet started → 409.
    const first = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ sessionId: VALID_ULID_SESSION }),
      ]),
    });
    expect(first.statusCode).toBe(409);

    // SDK side: re-issue session/start, then retry the same batch. The
    // route must have released the idempotency reservation so the same
    // eventId is not falsely counted as a duplicate.
    pool.knownSessions.add(`${TENANT}:${VALID_ULID_SESSION}`);
    const retry = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ sessionId: VALID_ULID_SESSION }),
      ]),
    });
    expect(retry.statusCode).toBe(202);
    const body = retry.json();
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(pool.insertedEventIds.has(VALID_ULID_A)).toBe(true);
  });

  it("strict off, session_id missing: existing behavior — event persisted with null session_id", async () => {
    const pool = new FakeSessionPool();
    const eventSink = new PostgresEventSink(pool);
    const { app } = await buildTestApp({ eventSink });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent()]),
    });

    expect(res.statusCode).toBe(202);
    expect(pool.insertedEventIds.has(VALID_ULID_A)).toBe(true);
    // No session derivation — the event had no sessionId to derive from.
    expect(
      pool.clientQueries.every((q) => !/INSERT INTO sessions/i.test(q.text))
    ).toBe(true);
  });
});

describe("POST /v1/session/start — idempotency", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("repeat call with same id returns 201 each time and keeps a single record", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    const first = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
      },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
      },
    });
    expect(second.statusCode).toBe(201);
    expect(sessionSink.getStart(TENANT, VALID_ULID_SESSION)).toBeDefined();
  });

  it("earlier startedAt on second call moves the row backwards (LEAST)", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T11:00:00.000Z",
      },
    });
    expect(sessionSink.getStart(TENANT, VALID_ULID_SESSION)?.startedAt).toBe(
      "2026-04-20T11:00:00.000Z"
    );
  });

  it("later startedAt on second call leaves the row unchanged (LEAST)", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:00:00.000Z",
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T13:00:00.000Z",
      },
    });
    expect(sessionSink.getStart(TENANT, VALID_ULID_SESSION)?.startedAt).toBe(
      "2026-04-20T12:00:00.000Z"
    );
  });

  it("identify on second call wins over the first", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:00:00.000Z",
        identify: { userId: "u-anon", traits: { plan: "free" } },
      },
    });
    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
        identify: { userId: "u-42", traits: { plan: "pro" } },
      },
    });
    const stored = sessionSink.getStart(TENANT, VALID_ULID_SESSION);
    expect(stored?.identify?.userId).toBe("u-42");
    expect(stored?.identify?.traits).toEqual({ plan: "pro" });
  });
});

describe("POST /v1/session/end — ended_reason", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("accepts inactivity / max_duration / explicit / shutdown reasons", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    for (const reason of ["inactivity", "max_duration", "explicit", "shutdown"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({
        method: "POST",
        url: "/v1/session/end",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          sessionId: VALID_ULID_SESSION,
          endedAt: "2026-04-20T13:00:00.000Z",
          reason,
        },
      });
      expect(res.statusCode).toBe(200);
    }
    // First-end-wins is the in-memory contract; the stored reason is the
    // first one we sent (`inactivity`).
    const stored = sessionSink.getEnd(TENANT, VALID_ULID_SESSION);
    expect(stored?.reason).toBe("inactivity");
  });

  it("rejects an unknown reason with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/end",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        sessionId: VALID_ULID_SESSION,
        endedAt: "2026-04-20T13:00:00.000Z",
        reason: "definitely_not_an_enum_member",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
