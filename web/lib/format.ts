/**
 * Human-readable relative-time formatter. Returns strings like
 * "5 seconds ago", "2 minutes ago", "3 hours ago", "4 days ago".
 * Falls back to `toLocaleString()` for anything older than ~30 days.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return iso;
  }
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) {
    return then.toLocaleString();
  }
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return then.toLocaleString();
}

/**
 * Format a canonical 8-char support code for display as two dash-separated
 * groups of four (e.g. "ABCD-1234"), which is easier to read aloud and copy.
 * Non-canonical lengths are returned unchanged so we never mangle unexpected
 * values.
 */
export function formatSupportCode(code: string): string {
  if (code.length !== 8) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
