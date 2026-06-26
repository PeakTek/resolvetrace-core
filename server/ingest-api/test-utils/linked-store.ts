/**
 * Linked event/session store for cross-feature integration tests.
 *
 * The unit-test mocks split the write side (`EventSink` / `SessionSink`) from
 * the read side (`SessionRepository` / `EventRepository`) — each route test
 * either writes OR seeds-and-reads, never both through the same store. The
 * cross-feature suite needs the SEAM between ingest and the portal read-side:
 * an event POSTed to `/v1/events` must later be visible via
 * `GET /api/v1/portal/sessions/:id`, and a `/v1/session/start` support code
 * must resolve via the by-support-code lookup.
 *
 * `LinkedSessionEventStore` implements all four interfaces over one backing
 * map so a single instance can be wired to BOTH the sink and repository slots
 * of `buildTestApp`, letting the integration tests prove the features compose
 * through the real Fastify route handlers (via `app.inject`) with no DB and no
 * network. It deliberately mirrors only the behaviour the seams rely on:
 * support-code minting/idempotency, started_at LEAST settling, live event
 * counts, and per-session event listing in capture order.
 */

import { generateSupportCode } from "../support-code.js";
import {
  EventRecord,
  EventRepository,
  EventSink,
  SessionEndRecord,
  SessionRecord,
  SessionRepository,
  SessionSink,
  SessionStartRecord,
  SessionStartResult,
  ValidatedEvent,
} from "../types.js";

interface StoredSession {
  sessionId: string;
  supportCode: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  appVersion: string | null;
  releaseChannel: string | null;
  userAnonId: string | null;
  client: unknown | null;
  replayChunkCount: number | null;
}

/** Map a wire/ingest envelope onto the persisted read model. */
function toEventRecord(evt: ValidatedEvent): EventRecord {
  return {
    eventId: evt.eventId,
    sessionId: evt.sessionId ?? null,
    type: evt.type,
    capturedAt: evt.capturedAt,
    attributes: evt.attributes ?? null,
    clockSkewDetected: evt.clockSkewDetected ?? false,
    schemaVersion: evt.schemaVersion ?? null,
    context: (evt.context as Record<string, unknown> | undefined) ?? null,
    severity: evt.severity ?? null,
    durationMs: evt.durationMs ?? null,
    httpStatus: evt.httpStatus ?? null,
    actor: evt.actor ?? null,
  };
}

export class LinkedSessionEventStore
  implements EventSink, SessionSink, SessionRepository, EventRepository
{
  /** `${tenantId}` -> sessionId -> session row. */
  private readonly sessions = new Map<string, Map<string, StoredSession>>();
  /** `${tenantId}` -> ordered event records. */
  private readonly events = new Map<string, EventRecord[]>();
  /** `${tenantId}:${supportCode}` -> sessionId (collision guard + lookup). */
  private readonly codeIndex = new Map<string, string>();

  private sessionsFor(tenantId: string): Map<string, StoredSession> {
    let m = this.sessions.get(tenantId);
    if (!m) {
      m = new Map();
      this.sessions.set(tenantId, m);
    }
    return m;
  }

  private eventsFor(tenantId: string): EventRecord[] {
    let arr = this.events.get(tenantId);
    if (!arr) {
      arr = [];
      this.events.set(tenantId, arr);
    }
    return arr;
  }

  private mintCode(tenantId: string): string {
    for (let i = 0; i < 8; i++) {
      const code = generateSupportCode();
      const key = `${tenantId}:${code}`;
      if (!this.codeIndex.has(key)) return code;
    }
    throw new Error("Exhausted support-code generation attempts");
  }

  // --- EventSink (write) ------------------------------------------------

  async enqueue(
    tenantId: string,
    events: ReadonlyArray<ValidatedEvent>
  ): Promise<void> {
    const store = this.eventsFor(tenantId);
    for (const evt of events) {
      store.push(toEventRecord(evt));
      // Auto-derive a minimal session row for events that carry a sessionId
      // but never went through /v1/session/start (lenient mode), so the live
      // event count + listing have a session to hang off — mirrors the
      // production sink's session upsert.
      if (evt.sessionId) {
        const sessions = this.sessionsFor(tenantId);
        if (!sessions.has(evt.sessionId)) {
          sessions.set(evt.sessionId, {
            sessionId: evt.sessionId,
            supportCode: this.mintCode(tenantId),
            startedAt: evt.capturedAt,
            endedAt: null,
            endedReason: null,
            appVersion: null,
            releaseChannel: null,
            userAnonId: null,
            client: null,
            replayChunkCount: null,
          });
        }
      }
    }
  }

  // --- SessionSink (write) ----------------------------------------------

  async recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<SessionStartResult> {
    const sessions = this.sessionsFor(tenantId);
    const existing = sessions.get(record.sessionId);
    if (existing) {
      // started_at settles to the earliest seen (LEAST), idempotent per session.
      if (record.startedAt < existing.startedAt) {
        existing.startedAt = record.startedAt;
      }
      if (record.appVersion !== undefined) existing.appVersion = record.appVersion;
      if (record.releaseChannel !== undefined)
        existing.releaseChannel = record.releaseChannel;
      if (record.userAnonId !== undefined) existing.userAnonId = record.userAnonId;
      if (record.client !== undefined) existing.client = record.client;
      this.codeIndex.set(`${tenantId}:${existing.supportCode}`, record.sessionId);
      return { supportCode: existing.supportCode };
    }
    const supportCode = this.mintCode(tenantId);
    this.codeIndex.set(`${tenantId}:${supportCode}`, record.sessionId);
    sessions.set(record.sessionId, {
      sessionId: record.sessionId,
      supportCode,
      startedAt: record.startedAt,
      endedAt: null,
      endedReason: null,
      appVersion: record.appVersion ?? null,
      releaseChannel: record.releaseChannel ?? null,
      userAnonId: record.userAnonId ?? null,
      client: record.client ?? null,
      replayChunkCount: null,
    });
    return { supportCode };
  }

  async recordEnd(tenantId: string, record: SessionEndRecord): Promise<void> {
    const row = this.sessionsFor(tenantId).get(record.sessionId);
    if (row && row.endedAt === null) {
      row.endedAt = record.endedAt;
      row.endedReason = record.reason;
    }
  }

  // --- SessionRepository (read) -----------------------------------------

  private toRecord(tenantId: string, s: StoredSession): SessionRecord {
    const eventCount = this.eventsFor(tenantId).filter(
      (e) => e.sessionId === s.sessionId
    ).length;
    return {
      sessionId: s.sessionId,
      supportCode: s.supportCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      endedReason: s.endedReason,
      appVersion: s.appVersion,
      releaseChannel: s.releaseChannel,
      userAnonId: s.userAnonId,
      eventCount,
      replayChunkCount: s.replayChunkCount,
      client: s.client,
    };
  }

  async list(
    tenantId: string,
    _opts: { limit: number; cursor?: string }
  ): Promise<{ sessions: SessionRecord[]; nextCursor?: string }> {
    const rows = [...this.sessionsFor(tenantId).values()]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map((s) => this.toRecord(tenantId, s));
    return { sessions: rows };
  }

  async get(tenantId: string, sessionId: string): Promise<SessionRecord | null> {
    const s = this.sessionsFor(tenantId).get(sessionId);
    return s ? this.toRecord(tenantId, s) : null;
  }

  async findBySupportCode(
    tenantId: string,
    supportCode: string
  ): Promise<SessionRecord | null> {
    const sessionId = this.codeIndex.get(`${tenantId}:${supportCode}`);
    if (!sessionId) return null;
    return this.get(tenantId, sessionId);
  }

  // --- EventRepository (read) -------------------------------------------

  async listBySession(
    tenantId: string,
    sessionId: string,
    _opts: { limit: number; cursor?: string }
  ): Promise<{ events: EventRecord[]; nextCursor?: string }> {
    const events = this.eventsFor(tenantId)
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : 1));
    return { events };
  }
}
