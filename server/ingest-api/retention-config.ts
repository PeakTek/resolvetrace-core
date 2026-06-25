/**
 * Retention configuration (governance feature #6, retention defaults).
 *
 * Three independent windows, in days, govern how long the server keeps each
 * data class before the purge runner deletes it:
 *
 *  - `RETENTION_EVENTS_DAYS`   — `events` rows.
 *  - `RETENTION_SESSIONS_DAYS` — `sessions` rows (and their events + replay).
 *  - `RETENTION_REPLAY_DAYS`   — replay chunk objects in storage (+ count).
 *
 * `0` or unset means "keep forever" for that class — the purge skips it. The
 * scheduled runner cadence and on/off are configured via:
 *
 *  - `RETENTION_PURGE_ENABLED`        — gate the scheduled runner (default on).
 *  - `RETENTION_PURGE_INTERVAL_HOURS` — cadence (default 24h / daily).
 *  - `RETENTION_PURGE_BATCH_SIZE`     — bounded delete batch size (default 500).
 *
 * Env supplies the *defaults*. When a `settings` table is present (migration
 * 005) an admin can override the three day-windows at runtime via the portal;
 * the resolved value is `setting ?? envDefault`. See `SettingsRepository`.
 */

/** Parsed, validated retention configuration. */
export interface RetentionConfig {
  /** Days to keep `events` rows. 0 = keep forever. */
  eventsDays: number;
  /** Days to keep `sessions` rows. 0 = keep forever. */
  sessionsDays: number;
  /** Days to keep replay chunk objects. 0 = keep forever. */
  replayDays: number;
  /** Whether the scheduled purge runner is enabled. */
  purgeEnabled: boolean;
  /** Scheduled purge cadence in hours. */
  purgeIntervalHours: number;
  /** Bounded delete batch size (rows per statement). */
  purgeBatchSize: number;
}

/** Raised when a retention env value is present but invalid. */
export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionConfigError";
  }
}

/**
 * Parse a non-negative-integer "days" value. Empty / undefined -> 0 (keep
 * forever). Anything else must be a non-negative integer, mirroring how the
 * rest of the server validates numeric config (fail fast at boot).
 */
function parseDays(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new RetentionConfigError(
      `${name} must be a non-negative integer number of days (got "${raw}").`
    );
  }
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new RetentionConfigError(
      `${name} must be a non-negative integer number of days (got "${raw}").`
    );
  }
  return n;
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new RetentionConfigError(
      `${name} must be a positive integer (got "${raw}").`
    );
  }
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new RetentionConfigError(
      `${name} must be an integer >= ${min} (got "${raw}").`
    );
  }
  return n;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Build the retention config from an env dictionary (defaults to
 * `process.env`). Throws `RetentionConfigError` on a malformed value so a
 * deployment misconfiguration fails fast at boot rather than silently keeping
 * data forever.
 */
export function loadRetentionConfig(
  env: NodeJS.ProcessEnv = process.env
): RetentionConfig {
  return {
    eventsDays: parseDays("RETENTION_EVENTS_DAYS", env.RETENTION_EVENTS_DAYS),
    sessionsDays: parseDays(
      "RETENTION_SESSIONS_DAYS",
      env.RETENTION_SESSIONS_DAYS
    ),
    replayDays: parseDays("RETENTION_REPLAY_DAYS", env.RETENTION_REPLAY_DAYS),
    purgeEnabled: parseBool(env.RETENTION_PURGE_ENABLED, true),
    purgeIntervalHours: parsePositiveInt(
      "RETENTION_PURGE_INTERVAL_HOURS",
      env.RETENTION_PURGE_INTERVAL_HOURS,
      24,
      1
    ),
    purgeBatchSize: parsePositiveInt(
      "RETENTION_PURGE_BATCH_SIZE",
      env.RETENTION_PURGE_BATCH_SIZE,
      500,
      1
    ),
  };
}

/**
 * The three day-windows, as surfaced to the portal. `source` tells the UI
 * whether the effective value came from a persisted admin override or the
 * environment default, so the read-only-vs-editable affordance is honest.
 */
export interface RetentionWindowsView {
  eventsDays: number;
  sessionsDays: number;
  replayDays: number;
}
