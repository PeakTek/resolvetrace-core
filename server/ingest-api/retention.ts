/**
 * Retention purge runner + targeted session deletion (governance feature #6).
 *
 * The purge deletes data past each configured retention window:
 *  - events older than the events window,
 *  - sessions older than the sessions window (cascading their events), and
 *  - replay chunk objects (in object storage) older than the replay window.
 *
 * It does NOT purge `audit_log` — audit history is retained (the table is
 * append-only with a DB guard; aging it out would require a privileged job
 * that disables that trigger, which is intentionally out of the normal app
 * path). Every purge run, and every targeted deletion, writes an audit record
 * via A1's non-fatal `recordAudit` writer with counts in `metadata`.
 *
 * Deletes are bounded-batch (the `PurgeStore` loops with a batch size) so a
 * large purge doesn't lock a table for an unbounded time. Replay storage keys
 * are derived from the canonical chunk-key layout used by the replay route:
 *
 *     <tenantId>/<sessionId>/<sequence>.rrweb
 */

import type { Logger } from "pino";
import type { ObjectStorage } from "../storage/index.js";
import type { PurgeStore, SettingsRepository } from "./types.js";
import type { RetentionConfig, RetentionWindowsView } from "./retention-config.js";
import { AuditAction, recordAudit } from "./audit.js";
import type { AuditSink } from "./types.js";

/** Persisted-setting keys for the editable retention overrides. */
export const SETTING_RETENTION_EVENTS_DAYS = "retention.events_days";
export const SETTING_RETENTION_SESSIONS_DAYS = "retention.sessions_days";
export const SETTING_RETENTION_REPLAY_DAYS = "retention.replay_days";

/** Scope that authorizes mutating retention/state and running a purge. */
export const SCOPE_RETENTION_ADMIN = "audit:read";

/** Counts returned from a purge run, per data class. */
export interface PurgeCounts {
  events: number;
  sessions: number;
  /** Replay chunk *objects* deleted from storage. */
  replayObjects: number;
}

/** Build the canonical storage key for a replay chunk. Mirrors the replay route. */
export function replayChunkKey(
  tenantId: string,
  sessionId: string,
  sequence: number
): string {
  return `${tenantId}/${sessionId}/${sequence}.rrweb`;
}

/**
 * Delete every replay chunk object for a session, given its chunk count.
 * Tolerant: a storage delete that throws is logged and skipped so one bad
 * object doesn't abort the whole purge. Returns the number of objects for
 * which delete was *invoked* (attempted).
 */
async function deleteReplayObjects(
  storage: ObjectStorage,
  tenantId: string,
  sessionId: string,
  replayChunkCount: number,
  logger?: Pick<Logger, "error">
): Promise<number> {
  let attempted = 0;
  for (let seq = 0; seq < replayChunkCount; seq++) {
    const key = replayChunkKey(tenantId, sessionId, seq);
    try {
      await storage.deleteObject(key);
    } catch (err) {
      // Best-effort: a missing or unreachable object must not abort the run.
      logger?.error({ err, key }, "replay object delete failed (non-fatal)");
    }
    attempted += 1;
  }
  return attempted;
}

/**
 * Resolve the effective retention windows: a persisted admin override (from
 * the settings store) wins over the environment default, per class. A blank
 * or unparseable override falls back to the env default.
 */
export async function resolveRetentionWindows(
  config: RetentionConfig,
  settings: SettingsRepository,
  tenantId: string
): Promise<RetentionWindowsView> {
  const all = await settings.getAll(tenantId).catch(() => ({}) as Record<string, string>);
  const pick = (key: string, fallback: number): number => {
    const raw = all[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    if (!/^[0-9]+$/.test(raw.trim())) return fallback;
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    eventsDays: pick(SETTING_RETENTION_EVENTS_DAYS, config.eventsDays),
    sessionsDays: pick(SETTING_RETENTION_SESSIONS_DAYS, config.sessionsDays),
    replayDays: pick(SETTING_RETENTION_REPLAY_DAYS, config.replayDays),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Dependencies the purge runner operates over. */
export interface PurgeRunnerDeps {
  purgeStore: PurgeStore;
  storage: ObjectStorage;
  settingsRepository: SettingsRepository;
  auditSink: AuditSink;
  retentionConfig: RetentionConfig;
}

/**
 * Run one purge pass for a tenant. Resolves the effective windows, deletes
 * past-window data in each class (events, then sessions+cascade, then orphan
 * replay), and writes a `retention.purge` audit record with the counts.
 *
 * `actor` is the principal label for the audit row (`system` for the
 * scheduled runner, the admin's principal for an on-demand call). The audit
 * write is non-fatal — a purge that deleted rows is not undone by an audit
 * failure.
 */
export async function runPurge(
  deps: PurgeRunnerDeps,
  tenantId: string,
  actor: string,
  now: Date = new Date(),
  logger?: Pick<Logger, "error" | "info">
): Promise<PurgeCounts> {
  const windows = await resolveRetentionWindows(
    deps.retentionConfig,
    deps.settingsRepository,
    tenantId
  );
  const batchSize = deps.retentionConfig.purgeBatchSize;
  const counts: PurgeCounts = { events: 0, sessions: 0, replayObjects: 0 };

  // 1. Replay objects past the replay window — delete storage objects for
  //    sessions that still carry chunks, then zero the count. Done before the
  //    session purge so a session that's past BOTH windows still has its
  //    objects removed via the session path's chunk info (idempotent: the
  //    second delete just no-ops on already-gone keys).
  if (windows.replayDays > 0) {
    const cutoff = new Date(now.getTime() - windows.replayDays * MS_PER_DAY);
    // Loop in bounded pages until no more aged sessions carry replay chunks.
    for (;;) {
      const page = await deps.purgeStore.listSessionsWithReplayOlderThan(
        tenantId,
        cutoff,
        batchSize
      );
      if (page.length === 0) break;
      for (const { sessionId, replayChunkCount } of page) {
        counts.replayObjects += await deleteReplayObjects(
          deps.storage,
          tenantId,
          sessionId,
          replayChunkCount,
          logger
        );
        await deps.purgeStore.clearReplayChunkCount(tenantId, sessionId);
      }
      if (page.length < batchSize) break;
    }
  }

  // 2. Sessions past the sessions window — cascade events + delete the session
  //    row, and remove any replay objects those sessions still carry.
  if (windows.sessionsDays > 0) {
    const cutoff = new Date(now.getTime() - windows.sessionsDays * MS_PER_DAY);
    const res = await deps.purgeStore.purgeSessionsOlderThan(
      tenantId,
      cutoff,
      batchSize
    );
    counts.sessions += res.sessionsDeleted;
    counts.events += res.eventsDeleted;
    for (const { sessionId, replayChunkCount } of res.replayChunks) {
      if (replayChunkCount > 0) {
        counts.replayObjects += await deleteReplayObjects(
          deps.storage,
          tenantId,
          sessionId,
          replayChunkCount,
          logger
        );
      }
    }
  }

  // 3. Events past the events window — for events not already swept by a
  //    session purge (e.g. orphan events, or a longer session window).
  if (windows.eventsDays > 0) {
    const cutoff = new Date(now.getTime() - windows.eventsDays * MS_PER_DAY);
    counts.events += await deps.purgeStore.purgeEventsOlderThan(
      tenantId,
      cutoff,
      batchSize
    );
  }

  await recordAudit(
    deps.auditSink,
    tenantId,
    {
      actor,
      action: AuditAction.RETENTION_PURGE,
      targetType: null,
      targetId: null,
      metadata: {
        counts,
        windows: {
          eventsDays: windows.eventsDays,
          sessionsDays: windows.sessionsDays,
          replayDays: windows.replayDays,
        },
      },
    },
    logger
  );

  logger?.info({ tenantId, counts, windows }, "retention purge complete");
  return counts;
}

/**
 * Targeted session deletion / right-to-erasure (Law-25). Hard-deletes one
 * session and cascades its events + replay storage objects, then writes a
 * `session.delete` audit record. Idempotent: deleting an unknown session is a
 * no-op that returns `found: false` (the route maps that to 404). The audit
 * row is written only when a session was actually deleted.
 */
export async function deleteSessionCascade(
  deps: Pick<PurgeRunnerDeps, "purgeStore" | "storage" | "auditSink">,
  tenantId: string,
  sessionId: string,
  actor: string,
  logger?: Pick<Logger, "error">
): Promise<{ found: boolean; eventsDeleted: number; replayObjects: number }> {
  const res = await deps.purgeStore.deleteSession(tenantId, sessionId);
  if (!res.found) {
    return { found: false, eventsDeleted: 0, replayObjects: 0 };
  }

  let replayObjects = 0;
  if (res.replayChunkCount > 0) {
    replayObjects = await deleteReplayObjects(
      deps.storage,
      tenantId,
      sessionId,
      res.replayChunkCount,
      logger
    );
  }

  await recordAudit(
    deps.auditSink,
    tenantId,
    {
      actor,
      action: AuditAction.SESSION_DELETE,
      targetType: "session",
      targetId: sessionId,
      metadata: {
        eventsDeleted: res.eventsDeleted,
        replayObjects,
      },
    },
    logger
  );

  return { found: true, eventsDeleted: res.eventsDeleted, replayObjects };
}
