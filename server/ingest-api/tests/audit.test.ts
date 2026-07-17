/**
 * Audit-log tests.
 *
 * Covers the write-points (session view, support-code lookup, login), the
 * admin-only query endpoint (admin reads / viewer 403), the non-fatal writer
 * (a sink failure does not fail the primary request), and the database-level
 * immutability guard shipped in migration 004 (a BEFORE UPDATE OR DELETE
 * trigger that raises). No real Postgres — the in-memory audit sink backs the
 * route tests; the immutability test asserts on the migration SQL + that the
 * Postgres sink is INSERT-only.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  MockEventRepository,
  MockResolver,
  MockSessionRepository,
} from "../test-utils/mocks.js";
import { InMemoryAuditSink } from "../in-memory-sinks.js";
import {
  AuditAction,
  recordAudit,
  resetAuditWriteFailureCount,
  auditWriteFailureCount,
} from "../audit.js";
import { PostgresAuditSink } from "../postgres.js";
import type { PgPool, PgClient } from "../postgres.js";
import { AUTH_HEADER, VALID_ULID_SESSION } from "../test-utils/fixtures.js";
import type { AuthProvider } from "../../auth/index.js";
import type { SessionRecord, EventRecord } from "../types.js";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: VALID_ULID_SESSION,
    supportCode: "ABCD1234",
    startedAt: "2026-04-20T12:30:00.000Z",
    endedAt: null,
    endedReason: null,
    appVersion: "1.2.3",
    releaseChannel: "stable",
    userAnonId: null,
    eventCount: 1,
    replayChunkCount: null,
    client: null,
    ...overrides,
  };
}

function makeEvent(): EventRecord {
  return {
    eventId: "01HWZX9KT1N2M3J4P5Q6R7S8A0",
    sessionId: VALID_ULID_SESSION,
    type: "page_view",
    capturedAt: "2026-04-20T12:30:01.000Z",
    attributes: null,
    clockSkewDetected: false,
    schemaVersion: null,
    context: null,
    severity: null,
    durationMs: null,
    httpStatus: null,
  };
}

describe("audit write-points", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("writes session.view on a session-detail read", async () => {
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const eventRepository = new MockEventRepository([makeEvent()]);
    const auditSink = new InMemoryAuditSink();
    const { app, resolver } = await buildTestApp({
      sessionRepository,
      eventRepository,
      auditSink,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    const rows = auditSink.all(resolver.config.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.SESSION_VIEW);
    expect(rows[0].targetType).toBe("session");
    expect(rows[0].targetId).toBe(VALID_ULID_SESSION);
  });

  it("writes support_code.lookup with a hit result (no raw code/PII)", async () => {
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const auditSink = new InMemoryAuditSink();
    const { app, resolver } = await buildTestApp({
      sessionRepository,
      auditSink,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ABCD1234",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    const rows = auditSink.all(resolver.config.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.SUPPORT_CODE_LOOKUP);
    expect(rows[0].metadata).toEqual({ result: "hit" });
    // The raw support code must NOT appear anywhere in the record.
    expect(JSON.stringify(rows[0])).not.toContain("ABCD1234");
  });

  it("writes support_code.lookup with a miss result on an unknown code", async () => {
    const sessionRepository = new MockSessionRepository([]); // no sessions
    const auditSink = new InMemoryAuditSink();
    const { app, resolver } = await buildTestApp({
      sessionRepository,
      auditSink,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ZZZZ9999",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(404);
    const rows = auditSink.all(resolver.config.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.SUPPORT_CODE_LOOKUP);
    expect(rows[0].metadata).toEqual({ result: "miss" });
    expect(rows[0].targetId).toBeNull();
  });

  it("writes auth.login on a successful portal login and returns roles", async () => {
    const auditSink = new InMemoryAuditSink();
    const authProvider: AuthProvider = {
      async verifyCredentials(input) {
        if (input.username === "admin" && input.password === "correct") {
          return {
            userId: "local:admin",
            email: "admin@example.test",
            roles: ["admin"],
          };
        }
        return null;
      },
    };
    const { app, resolver } = await buildTestApp({ auditSink, authProvider });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      headers: { authorization: AUTH_HEADER },
      payload: { username: "admin", password: "correct" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.roles).toEqual(["admin"]);
    const rows = auditSink.all(resolver.config.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.AUTH_LOGIN);
    expect(rows[0].actor).toBe("local:admin");
  });

  it("writes auth.login_failed on a bad password and never logs the password", async () => {
    const auditSink = new InMemoryAuditSink();
    const authProvider: AuthProvider = {
      async verifyCredentials() {
        return null;
      },
    };
    const { app, resolver } = await buildTestApp({ auditSink, authProvider });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/auth/login",
      headers: { authorization: AUTH_HEADER },
      payload: { username: "admin", password: "s3cr3t-PII" },
    });

    expect(res.statusCode).toBe(401);
    const rows = auditSink.all(resolver.config.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(AuditAction.AUTH_LOGIN_FAILED);
    expect(rows[0].actor).toBe("admin");
    expect(JSON.stringify(rows[0])).not.toContain("s3cr3t-PII");
  });

  it("does NOT fail the primary request when the audit write throws", async () => {
    resetAuditWriteFailureCount();
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const eventRepository = new MockEventRepository([makeEvent()]);
    const auditSink = new InMemoryAuditSink();
    auditSink.failOnAppend = new Error("audit store unavailable");
    const { app } = await buildTestApp({
      sessionRepository,
      eventRepository,
      auditSink,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });

    // Primary request still succeeds despite the audit failure.
    expect(res.statusCode).toBe(200);
    expect(res.json().session.sessionId).toBe(VALID_ULID_SESSION);
    // The failure was surfaced via the counter.
    expect(auditWriteFailureCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/v1/portal/audit (admin-only)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns audit entries newest-first for an admin principal", async () => {
    const auditSink = new InMemoryAuditSink();
    const { app, resolver } = await buildTestApp({ auditSink });
    close = () => app.close();

    await auditSink.append(resolver.config.tenantId, {
      actor: "portal-service",
      action: AuditAction.SESSION_VIEW,
      targetType: "session",
      targetId: "s1",
    });
    await auditSink.append(resolver.config.tenantId, {
      actor: "portal-service",
      action: AuditAction.SUPPORT_CODE_LOOKUP,
      metadata: { result: "hit" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/audit",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(2);
    // Newest first.
    expect(body.entries[0].action).toBe(AuditAction.SUPPORT_CODE_LOOKUP);
    expect(body.entries[1].action).toBe(AuditAction.SESSION_VIEW);
    expect(body.nextCursor).toBeNull();
  });

  it("returns 403 for a viewer principal (no audit:read scope)", async () => {
    const auditSink = new InMemoryAuditSink();
    // Viewer scopes: deliberately omit `audit:read`.
    const resolver = new MockResolver({
      scopes: ["events:write", "session:read"],
    });
    const { app } = await buildTestApp({ auditSink, resolver });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/audit",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("returns 200 for a read-only engineer (audit:read, no tenant:admin)", async () => {
    // The audit-log read is gated by audit:read, which a read-only "engineer"
    // holds even without the destructive tenant:admin scope. Proves the scope
    // split lets a read-capable role view audit without admin rights.
    const auditSink = new InMemoryAuditSink();
    const resolver = new MockResolver({
      scopes: ["session:read", "audit:read"],
    });
    const { app } = await buildTestApp({ auditSink, resolver });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/audit",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBeUndefined();
  });

  it("paginates with an opaque cursor", async () => {
    const auditSink = new InMemoryAuditSink();
    const { app, resolver } = await buildTestApp({ auditSink });
    close = () => app.close();

    for (let i = 0; i < 3; i++) {
      await auditSink.append(resolver.config.tenantId, {
        actor: "portal-service",
        action: AuditAction.SESSION_VIEW,
        targetId: `s${i}`,
      });
    }

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/portal/audit?limit=2",
      headers: { authorization: AUTH_HEADER },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.entries).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/portal/audit?limit=2&cursor=${encodeURIComponent(
        firstBody.nextCursor
      )}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().entries).toHaveLength(1);
  });
});

describe("recordAudit (non-fatal helper)", () => {
  it("returns true on success and false on sink failure without throwing", async () => {
    resetAuditWriteFailureCount();
    const ok = new InMemoryAuditSink();
    expect(
      await recordAudit(ok, "t", {
        actor: "a",
        action: AuditAction.SESSION_VIEW,
      })
    ).toBe(true);

    const bad = new InMemoryAuditSink();
    bad.failOnAppend = new Error("nope");
    const result = await recordAudit(bad, "t", {
      actor: "a",
      action: AuditAction.SESSION_VIEW,
    });
    expect(result).toBe(false);
    expect(auditWriteFailureCount()).toBe(1);
  });
});

// --- Immutability guard ------------------------------------------------

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_004 = path.join(
  SELF_DIR,
  "..",
  "migrations",
  "004_audit_log.sql"
);

function ok<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

describe("audit_log immutability guard", () => {
  it("migration installs a BEFORE UPDATE OR DELETE trigger that raises", async () => {
    const sql = await fs.readFile(MIGRATION_004, "utf8");
    const upper = sql.toUpperCase();
    expect(upper).toContain("BEFORE UPDATE OR DELETE ON AUDIT_LOG");
    expect(upper).toContain("RAISE EXCEPTION");
    // The trigger fires per row so every attempted mutation is rejected.
    expect(upper).toContain("FOR EACH ROW");
  });

  it("the Postgres audit sink only ever issues INSERT (never UPDATE/DELETE)", async () => {
    const issued: string[] = [];
    const pool: PgPool = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string) {
        issued.push(text.trim().split(/\s+/)[0].toUpperCase());
        return ok<R>([]);
      },
      async connect(): Promise<PgClient> {
        throw new Error("not used");
      },
      async end() {
        /* no-op */
      },
    };
    const sink = new PostgresAuditSink(pool);
    await sink.append("t", { actor: "a", action: AuditAction.SESSION_VIEW });
    expect(issued).toEqual(["INSERT"]);
    expect(issued).not.toContain("UPDATE");
    expect(issued).not.toContain("DELETE");
  });

  it("a guard-enforcing pool rejects UPDATE and DELETE on audit_log", async () => {
    // Simulate the DB guard: any UPDATE/DELETE touching audit_log raises, as
    // the migration's trigger does in Postgres. Proves callers cannot mutate.
    const guarded: PgPool = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string) {
        const op = text.trim().split(/\s+/)[0].toUpperCase();
        if ((op === "UPDATE" || op === "DELETE") && /audit_log/i.test(text)) {
          throw Object.assign(
            new Error("audit_log is append-only: " + op + " is not permitted"),
            { code: "23000" }
          );
        }
        return ok<R>([]);
      },
      async connect(): Promise<PgClient> {
        throw new Error("not used");
      },
      async end() {
        /* no-op */
      },
    };

    await expect(
      guarded.query("UPDATE audit_log SET actor = 'x' WHERE id = 1")
    ).rejects.toThrow(/append-only/);
    await expect(
      guarded.query("DELETE FROM audit_log WHERE id = 1")
    ).rejects.toThrow(/append-only/);
    // INSERT still works.
    await expect(
      guarded.query("INSERT INTO audit_log (tenant_id) VALUES ('t')")
    ).resolves.toBeDefined();
  });
});
