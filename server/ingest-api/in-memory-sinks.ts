/**
 * In-memory implementations of `EventSink` and `SessionSink`.
 *
 * Wave 4 OSS scope: the HTTP surface is end-to-end but durable persistence
 * lands in a later wave. These sinks keep the server observably correct
 * (no dropped requests, deterministic test fixtures) without pretending
 * to be a real queue or DB.
 *
 * A real implementation swaps these out without touching route code.
 */

import {
  EventSink,
  SessionEndRecord,
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
    // Idempotent — first writer wins. A repeat start with the same id is a no-op.
    if (!this.startRecords.has(key)) {
      this.startRecords.set(key, { ...record });
    }
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
