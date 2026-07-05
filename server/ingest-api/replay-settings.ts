/**
 * Tenant replay settings (masked-replay feature #1, policy enforcement).
 *
 * Persisted in the Wave-23 `settings` key/value table (migration 005) so the
 * surface ships without a new table. Three keys back the tenant-level replay
 * policy:
 *
 *   replay.enabled         -- "true"/"false". When false, the backend rejects
 *                             all replay uploads for the tenant.
 *   replay.sample_rate     -- "0".."1" float. Surfaced to the SDK as the
 *                             sampling target; not enforced server-side (the
 *                             SDK samples at capture time), but persisted here
 *                             as the policy source of truth.
 *   replay.route_deny_list -- JSON array of route names/globs. The backend
 *                             rejects replay uploads whose session is on a
 *                             deny-listed route; the SDK also honours it.
 *
 * doc-18 replay_defaults are non-negotiable masking defaults applied in the
 * SDK; these settings govern *whether/where* replay is captured, never how it
 * is masked. The default policy is replay ENABLED with an empty deny-list and
 * full sampling — masking-on-by-default makes "enabled" safe.
 */

import type { SettingsRepository } from "./types.js";

export const SETTING_REPLAY_MODE = "replay.mode";
export const SETTING_REPLAY_ENABLED = "replay.enabled";
export const SETTING_REPLAY_SAMPLE_RATE = "replay.sample_rate";
export const SETTING_REPLAY_ROUTE_DENY_LIST = "replay.route_deny_list";

/** Defaults when no tenant override is persisted. */
export const REPLAY_DEFAULTS = {
  mode: "auto",
  enabled: true,
  sampleRate: 1,
  routeDenyList: [] as string[],
} as const;

/** Effective tenant replay policy. */
export interface ReplaySettingsView {
  /**
   * Replay trigger the deployment hands to the SDK. This server is
   * all-or-nothing: only `'auto'` (record whole sessions) or `'off'` (never).
   * `'manual'` — recording gated by an external consent trigger — is not
   * something this server drives, so it never appears here (a persisted
   * `'manual'` fails safe to `'off'`).
   */
  mode: "auto" | "off";
  enabled: boolean;
  /** Float in [0, 1]. */
  sampleRate: number;
  /** Route names / glob patterns where replay is suppressed. */
  routeDenyList: string[];
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

function parseRate(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/**
 * Resolve the persisted replay trigger to the auto/off this server can honor.
 * Unset or unrecognized values fall back to the default. `'manual'` is
 * recognized but clamped to `'off'`: manual recording needs an external consent
 * trigger this server does not provide, so failing safe (record nothing) is
 * preferable to auto-recording sessions the operator meant to gate.
 */
function parseMode(
  raw: string | undefined,
  fallback: "auto" | "off"
): "auto" | "off" {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "auto") return "auto";
  if (v === "off" || v === "manual") return "off";
  return fallback;
}

function parseDenyList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // Fall through to comma-split tolerance below.
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the effective replay settings for a tenant from the settings store,
 * falling back to `REPLAY_DEFAULTS` for any unset key.
 */
export async function resolveReplaySettings(
  settings: SettingsRepository,
  tenantId: string
): Promise<ReplaySettingsView> {
  const all = await settings
    .getAll(tenantId)
    .catch(() => ({}) as Record<string, string>);
  return {
    mode: parseMode(all[SETTING_REPLAY_MODE], REPLAY_DEFAULTS.mode),
    enabled: parseBool(all[SETTING_REPLAY_ENABLED], REPLAY_DEFAULTS.enabled),
    sampleRate: parseRate(
      all[SETTING_REPLAY_SAMPLE_RATE],
      REPLAY_DEFAULTS.sampleRate
    ),
    routeDenyList: parseDenyList(all[SETTING_REPLAY_ROUTE_DENY_LIST]),
  };
}

/** Normalize a route name for deny-list comparison (case-insensitive, trimmed). */
function normRoute(route: string): string {
  return route.trim().toLowerCase();
}

/**
 * Decide whether a replay upload is permitted under the tenant's policy.
 * `routeName` is the route the chunk's session is on (when known) — supplied
 * by the SDK at signed-url time and echoed at complete time. A deny-list match
 * (exact, or a trailing `*` prefix glob) suppresses replay. When replay is
 * disabled tenant-wide, every upload is rejected.
 */
export function isReplayAllowed(
  policy: ReplaySettingsView,
  routeName?: string | null
): { allowed: boolean; reason?: "replay_disabled" | "route_denied" } {
  if (!policy.enabled) return { allowed: false, reason: "replay_disabled" };
  if (routeName && policy.routeDenyList.length > 0) {
    const candidate = normRoute(routeName);
    for (const pattern of policy.routeDenyList) {
      const p = normRoute(pattern);
      if (p.endsWith("*")) {
        if (candidate.startsWith(p.slice(0, -1))) {
          return { allowed: false, reason: "route_denied" };
        }
      } else if (candidate === p) {
        return { allowed: false, reason: "route_denied" };
      }
    }
  }
  return { allowed: true };
}
