/**
 * Neutral usage math shared by the portal usage view.
 *
 * GB-month = GB stored × (retention window in days / 30) — a pure volume×time
 * figure with NO pricing or billing semantics (those live in a composing
 * server). Keep-forever retention (`replayDays === 0`) has no finite window, so
 * it falls back to the reporting period itself, matching how a composing meter
 * rolls the same figure up.
 */

const GB_BYTES = 1_000_000_000;
const DAYS_PER_MONTH = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Convert durably-stored replay `bytes` retained for `replayDays` into GB-month
 * over `[periodStart, periodEnd)`. Returns 0 for empty input or a non-positive
 * window.
 */
export function bytesToGbMonth(
  bytes: number,
  replayDays: number,
  periodStart: Date,
  periodEnd: Date
): number {
  if (bytes <= 0) return 0;
  const windowDays =
    replayDays > 0
      ? replayDays
      : Math.max((periodEnd.getTime() - periodStart.getTime()) / DAY_MS, 0);
  if (windowDays <= 0) return 0;
  return (bytes / GB_BYTES) * (windowDays / DAYS_PER_MONTH);
}
