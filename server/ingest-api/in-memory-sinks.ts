/**
 * In-memory implementations of `EventSink`, `SessionSink`, and empty-read
 * stubs for the session / event repositories.
 *
 * The sinks are used by the test suite via `buildTestApp`. The empty
 * repository stubs are also used by `main.ts` when `DATABASE_URL` is not
 * configured, so the ingest server can still boot for smoke tests without
 * a database; the portal query routes then just return empty lists.
 */

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

export class InMemoryEventSink implements EventSink {
  private readonly queue: Array<{
    tenantId: string;
    events: ValidatedEvent[];
  }> = [];

  async enqueue(
    tenantId: string,
    events: ReadonlyArray<ValidatedEvent>
  ): Promise<void> {
    this.queue.push({ tenantId, events: [...events] });
  }

  /** Visible for tests / future workers. */
  drain(): Array<{ tenantId: string; events: ValidatedEvent[] }> {
    return this.queue.splice(0, this.queue.length);
  }

  /** Visible for tests. */
  size(): number {
    return this.queue.length;
  }
}

export class InMemorySessionSink implements SessionSink {
  private readonly startRecords = new Map<string, SessionStartRecord>();
  private readonly endRecords = new Map<string, SessionEndRecord>();

  async recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<void> {
    const key = `${tenantId}:${record.sessionId}`;
    const existing = this.startRecords.get(key);
    if (!existing) {
      this.startRecords.set(key, { ...record });
      return;
    }
    // Idempotent upsert. `started_at` settles to the earliest seen value
    // (LEAST), so a repeat start with a later timestamp doesn't move the
    // session forward. When `identify` is provided, it wins outright over
    // any previously stored identity for this session — the SDK only
    // re-issues start with identify when there's a new identity to project.
    const earlierStartedAt =
      existing.startedAt <= record.startedAt
        ? existing.startedAt
        : record.startedAt;
    const merged: SessionStartRecord = {
      ...existing,
      ...record,
      startedAt: earlierStartedAt,
    };
    if (record.identify === undefined) {
      merged.identify = existing.identify;
    }
    this.startRecords.set(key, merged);
  }

  async recordEnd(
    tenantId: string,
    record: SessionEndRecord
  ): Promise<void> {
    const key = `${tenantId}:${record.sessionId}`;
    if (!this.endRecords.has(key)) {
      this.endRecords.set(key, { ...record });
    }
  }

  /** Visible for tests. */
  getStart(tenantId: string, sessionId: string): SessionStartRecord | undefined {
    return this.startRecords.get(`${tenantId}:${sessionId}`);
  }

  /** Visible for tests. */
  getEnd(tenantId: string, sessionId: string): SessionEndRecord | undefined {
    return this.endRecords.get(`${tenantId}:${sessionId}`);
  }
}

/**
 * Repository stub that always returns an empty list / null. Used when the
 * server boots without `DATABASE_URL` configured — the query endpoints
 * still respond correctly, there's just nothing to show.
 */
export class EmptySessionRepository implements SessionRepository {
  async list(): Promise<{ sessions: SessionRecord[]; nextCursor?: string }> {
    return { sessions: [] };
  }
  async get(): Promise<SessionRecord | null> {
    return null;
  }
}

export class EmptyEventRepository implements EventRepository {
  async listBySession(): Promise<{
    events: EventRecord[];
    nextCursor?: string;
  }> {
    return { events: [] };
  }
}
