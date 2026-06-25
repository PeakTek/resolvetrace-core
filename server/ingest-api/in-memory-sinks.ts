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
  SessionStartResult,
  ValidatedEvent,
} from "./types.js";
import { generateSupportCode } from "./support-code.js";

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
  /** `${tenantId}:${sessionId}` -> minted support code. */
  private readonly supportCodes = new Map<string, string>();
  /** `${tenantId}:${supportCode}` -> sessionId, for collision checks + lookup. */
  private readonly supportCodeIndex = new Map<string, string>();

  /**
   * Mint a support code unique within the tenant, idempotent per session: a
   * repeat start with the same `(tenantId, sessionId)` returns the SAME code.
   */
  private mintSupportCode(tenantId: string, sessionId: string): string {
    const key = `${tenantId}:${sessionId}`;
    const existing = this.supportCodes.get(key);
    if (existing) return existing;
    // Bounded retry on the (astronomically rare) per-tenant collision.
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateSupportCode();
      const indexKey = `${tenantId}:${code}`;
      if (!this.supportCodeIndex.has(indexKey)) {
        this.supportCodes.set(key, code);
        this.supportCodeIndex.set(indexKey, sessionId);
        return code;
      }
    }
    throw new Error("Exhausted support-code generation attempts");
  }

  async recordStart(
    tenantId: string,
    record: SessionStartRecord
  ): Promise<SessionStartResult> {
    const key = `${tenantId}:${record.sessionId}`;
    const supportCode = this.mintSupportCode(tenantId, record.sessionId);
    const existing = this.startRecords.get(key);
    if (!existing) {
      this.startRecords.set(key, { ...record });
      return { supportCode };
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
    return { supportCode };
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

  /** Visible for tests — the support code minted for this session, if any. */
  getSupportCode(tenantId: string, sessionId: string): string | undefined {
    return this.supportCodes.get(`${tenantId}:${sessionId}`);
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
  async findBySupportCode(): Promise<SessionRecord | null> {
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
