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
  SessionEndRecord,
  SessionRecord,
  SessionRepository,
  SessionSink,
  SessionStartRecord,
  SessionStartResult,
  SettingsRepository,
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

/**
 * In-memory audit sink + repository. Append-only by construction (no update /
 * delete surface). Used by the test suite and as the default fallback when the
 * server boots without `DATABASE_URL`. Implements both `AuditSink` (write) and
 * `AuditRepository` (read) over a single backing array so tests can write via
 * the handlers and read back via the query endpoint.
 */
export class InMemoryAuditSink implements AuditSink, AuditRepository {
  private readonly byTenant = new Map<string, AuditRecord[]>();
  /** When set, `append` throws this error — used to test non-fatal writes. */
  public failOnAppend: Error | null = null;

  async append(tenantId: string, record: AuditRecordInput): Promise<void> {
    if (this.failOnAppend) {
      throw this.failOnAppend;
    }
    this.rowsFor(tenantId).push({
      actor: record.actor,
      action: record.action,
      targetType: record.targetType ?? null,
      targetId: record.targetId ?? null,
      occurredAt: new Date().toISOString(),
      metadata: record.metadata ?? null,
    });
  }

  private rowsFor(tenantId: string): AuditRecord[] {
    let arr = this.byTenant.get(tenantId);
    if (!arr) {
      arr = [];
      this.byTenant.set(tenantId, arr);
    }
    return arr;
  }

  async list(
    tenantId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ entries: AuditRecord[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
    // Newest first. The opaque cursor is the 0-based offset of the next page.
    const all = [...this.rowsFor(tenantId)].reverse();
    let start = 0;
    if (opts.cursor) {
      const parsed = parseInt(
        Buffer.from(opts.cursor, "base64").toString("utf8"),
        10
      );
      if (Number.isFinite(parsed) && parsed >= 0) start = parsed;
    }
    const slice = all.slice(start, start + limit);
    const hasMore = all.length > start + limit;
    const nextCursor = hasMore
      ? Buffer.from(String(start + limit), "utf8").toString("base64")
      : undefined;
    return nextCursor ? { entries: slice, nextCursor } : { entries: slice };
  }

  /** Visible for tests — all rows for a tenant in insertion order. */
  all(tenantId: string): AuditRecord[] {
    return [...this.rowsFor(tenantId)];
  }
}

/**
 * In-memory key/value settings store. Backs tests and the DATABASE_URL-less
 * smoke path (where retention overrides are non-durable but the surface still
 * works).
 */
export class InMemorySettingsRepository implements SettingsRepository {
  private readonly byTenant = new Map<string, Map<string, string>>();

  async getAll(tenantId: string): Promise<Record<string, string>> {
    const m = this.byTenant.get(tenantId);
    return m ? Object.fromEntries(m) : {};
  }

  async set(tenantId: string, key: string, value: string): Promise<void> {
    let m = this.byTenant.get(tenantId);
    if (!m) {
      m = new Map();
      this.byTenant.set(tenantId, m);
    }
    m.set(key, value);
  }
}

/**
 * In-memory replay manifest store. Backs the route/read-side tests and the
 * DATABASE_URL-less smoke path. `recordChunk` is idempotent per
 * `(tenant, session, sequence)` and reports whether the row was first-seen so
 * the caller's counter logic can mirror the Postgres store.
 */
export class InMemoryReplayManifestStore implements ReplayManifestStore {
  /** `${tenantId}` -> `${sessionId}:${sequence}` -> row. */
  private readonly byTenant = new Map<
    string,
    Map<string, ReplayManifestRecord>
  >();

  private rowsFor(tenantId: string): Map<string, ReplayManifestRecord> {
    let m = this.byTenant.get(tenantId);
    if (!m) {
      m = new Map();
      this.byTenant.set(tenantId, m);
    }
    return m;
  }

  async recordChunk(
    tenantId: string,
    input: ReplayManifestInput
  ): Promise<{ inserted: boolean }> {
    const rows = this.rowsFor(tenantId);
    const k = `${input.sessionId}:${input.sequence}`;
    const inserted = !rows.has(k);
    rows.set(k, {
      sessionId: input.sessionId,
      sequence: input.sequence,
      key: input.key,
      bytes: input.bytes,
      sha256: input.sha256,
      scrubber: input.scrubber ?? null,
      clientUploadedAt: input.clientUploadedAt ?? null,
      uploadedAt: new Date().toISOString(),
    });
    return { inserted };
  }

  async listBySession(
    tenantId: string,
    sessionId: string
  ): Promise<ReplayManifestRecord[]> {
    return [...this.rowsFor(tenantId).values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Visible for tests / purge delegation: exact keys for a session. */
  keysFor(tenantId: string, sessionId: string): string[] {
    return [...this.rowsFor(tenantId).values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((r) => r.key);
  }

  /** Visible for tests / purge delegation: drop a session's rows. */
  deleteFor(tenantId: string, sessionId: string): number {
    const rows = this.rowsFor(tenantId);
    let n = 0;
    for (const [k, r] of rows) {
      if (r.sessionId === sessionId) {
        rows.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

/** A seedable in-memory session row for the purge store. */
export interface PurgeSessionSeed {
  sessionId: string;
  /** ISO 8601 session start time — compared against the purge cutoff. */
  startedAt: string;
  replayChunkCount?: number;
}

/** A seedable in-memory event row for the purge store. */
export interface PurgeEventSeed {
  eventId: string;
  sessionId: string | null;
  /** ISO 8601 capture time — compared against the events cutoff. */
  capturedAt: string;
}

/**
 * In-memory `PurgeStore` for tests + the DATABASE_URL-less smoke path. Seed it
 * with session/event rows and assert which survive a purge. Tenant-scoped to
 * match the Postgres implementation. The smoke fallback seeds nothing, so a
 * purge there is a well-formed no-op.
 */
export class InMemoryPurgeStore implements PurgeStore {
  private sessions = new Map<string, PurgeSessionSeed[]>();
  private events = new Map<string, PurgeEventSeed[]>();

  /**
   * Optional linked manifest store. When set, the purge store's replay-key
   * lookups/deletes delegate to it (authoritative exact keys) instead of
   * falling back to count-derived keys. Lets a test (or the smoke path) prove
   * the manifest-driven purge end to end with one shared store.
   */
  constructor(private readonly manifestStore?: InMemoryReplayManifestStore) {}

  /** Seed sessions for a tenant (replaces any existing seed). */
  seedSessions(tenantId: string, rows: PurgeSessionSeed[]): void {
    this.sessions.set(tenantId, rows.map((r) => ({ ...r })));
  }

  /** Seed events for a tenant (replaces any existing seed). */
  seedEvents(tenantId: string, rows: PurgeEventSeed[]): void {
    this.events.set(tenantId, rows.map((r) => ({ ...r })));
  }

  /** Visible for tests — surviving sessions for a tenant. */
  sessionsFor(tenantId: string): PurgeSessionSeed[] {
    return [...(this.sessions.get(tenantId) ?? [])];
  }

  /** Visible for tests — surviving events for a tenant. */
  eventsFor(tenantId: string): PurgeEventSeed[] {
    return [...(this.events.get(tenantId) ?? [])];
  }

  async purgeEventsOlderThan(
    tenantId: string,
    cutoff: Date,
    _batchSize: number
  ): Promise<number> {
    const rows = this.events.get(tenantId) ?? [];
    const cut = cutoff.getTime();
    const kept = rows.filter((e) => new Date(e.capturedAt).getTime() >= cut);
    const deleted = rows.length - kept.length;
    this.events.set(tenantId, kept);
    return deleted;
  }

  async listSessionsWithReplayOlderThan(
    tenantId: string,
    cutoff: Date,
    limit: number
  ): Promise<Array<{ sessionId: string; replayChunkCount: number }>> {
    const rows = this.sessions.get(tenantId) ?? [];
    const cut = cutoff.getTime();
    return rows
      .filter(
        (s) =>
          new Date(s.startedAt).getTime() < cut &&
          (s.replayChunkCount ?? 0) > 0
      )
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.sessionId,
        replayChunkCount: s.replayChunkCount ?? 0,
      }));
  }

  async clearReplayChunkCount(
    tenantId: string,
    sessionId: string
  ): Promise<void> {
    const rows = this.sessions.get(tenantId) ?? [];
    for (const s of rows) {
      if (s.sessionId === sessionId) s.replayChunkCount = 0;
    }
  }

  async listReplayManifestKeys(
    tenantId: string,
    sessionId: string
  ): Promise<string[]> {
    return this.manifestStore?.keysFor(tenantId, sessionId) ?? [];
  }

  async deleteReplayManifest(
    tenantId: string,
    sessionId: string
  ): Promise<number> {
    return this.manifestStore?.deleteFor(tenantId, sessionId) ?? 0;
  }

  async purgeSessionsOlderThan(
    tenantId: string,
    cutoff: Date,
    _batchSize: number
  ): Promise<{
    sessionsDeleted: number;
    eventsDeleted: number;
    replayChunks: Array<{ sessionId: string; replayChunkCount: number }>;
  }> {
    const rows = this.sessions.get(tenantId) ?? [];
    const cut = cutoff.getTime();
    const doomed = rows.filter((s) => new Date(s.startedAt).getTime() < cut);
    const kept = rows.filter((s) => new Date(s.startedAt).getTime() >= cut);
    this.sessions.set(tenantId, kept);

    const doomedIds = new Set(doomed.map((s) => s.sessionId));
    const evRows = this.events.get(tenantId) ?? [];
    const evKept = evRows.filter(
      (e) => e.sessionId == null || !doomedIds.has(e.sessionId)
    );
    const eventsDeleted = evRows.length - evKept.length;
    this.events.set(tenantId, evKept);

    return {
      sessionsDeleted: doomed.length,
      eventsDeleted,
      replayChunks: doomed
        .filter((s) => (s.replayChunkCount ?? 0) > 0)
        .map((s) => ({
          sessionId: s.sessionId,
          replayChunkCount: s.replayChunkCount ?? 0,
        })),
    };
  }

  async deleteSession(
    tenantId: string,
    sessionId: string
  ): Promise<{
    found: boolean;
    eventsDeleted: number;
    replayChunkCount: number;
  }> {
    const rows = this.sessions.get(tenantId) ?? [];
    const target = rows.find((s) => s.sessionId === sessionId);
    if (!target) {
      return { found: false, eventsDeleted: 0, replayChunkCount: 0 };
    }
    this.sessions.set(
      tenantId,
      rows.filter((s) => s.sessionId !== sessionId)
    );
    const evRows = this.events.get(tenantId) ?? [];
    const evKept = evRows.filter((e) => e.sessionId !== sessionId);
    const eventsDeleted = evRows.length - evKept.length;
    this.events.set(tenantId, evKept);
    return {
      found: true,
      eventsDeleted,
      replayChunkCount: target.replayChunkCount ?? 0,
    };
  }
}

