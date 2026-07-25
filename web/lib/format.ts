/** Portal date/time display defaults when a tenant has no locale/timezone. */
export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_TIMEZONE = "UTC";

/**
 * Format an ISO timestamp as an EXACT date-time, in an explicit locale +
 * timezone. Because the timezone is explicit, the output is deterministic
 * across the Node server (SSR) and the browser — it never depends on the
 * runtime's own zone. Falls back to `en-US` / `UTC` when unset, and returns the
 * raw input for an unparseable date. Example (en-US, America/New_York):
 * "Jul 24, 2026, 2:05 PM".
 */
export function formatDateTime(
  iso: string,
  opts: { locale?: string; timeZone?: string } = {}
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const fmt = (locale: string, timeZone: string): string =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(d);
  try {
    return fmt(opts.locale || DEFAULT_LOCALE, opts.timeZone || DEFAULT_TIMEZONE);
  } catch {
    // A stored locale/timezone the runtime rejects — never throw in render.
    return fmt(DEFAULT_LOCALE, DEFAULT_TIMEZONE);
  }
}

/**
 * Format `iso` using the CURRENT tenant's locale + timezone from a portal
 * session. Accepts the shared session shape (`getSession()` server-side or
 * `useSession()` client-side); both carry `tenants[]` + `currentTenantId`.
 */
export function formatTenantTime(
  session:
    | {
        tenants: { id: string; locale?: string; timezone?: string }[];
        currentTenantId?: string;
      }
    | null
    | undefined,
  iso: string
): string {
  const t = session?.tenants.find((x) => x.id === session.currentTenantId);
  return formatDateTime(iso, { locale: t?.locale, timeZone: t?.timezone });
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
