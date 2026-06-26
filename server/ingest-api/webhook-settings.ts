/**
 * Tenant webhook config (in-app problem reporting → ticketing, feature #5).
 *
 * When a `support.report_submitted` event is ingested, the backend forwards the
 * (already-scrubbed) report to the tenant's configured webhook server-side. The
 * config lives in the Wave-23 `settings` key/value table (migration 005) so the
 * surface ships without a new table. Three keys back it:
 *
 *   webhook.enabled  -- "true"/"false". When false (or unset), no dispatch.
 *   webhook.url      -- https endpoint the report POST is sent to.
 *   webhook.secret   -- per-tenant HMAC secret. WRITE-ONLY: the admin can set
 *                       it but the API never returns it; the read endpoint only
 *                       reports whether a secret is configured. It is used to
 *                       sign the request body and is NEVER logged or echoed.
 *
 * The secret stays server-side only. The dispatch payload carries scrubbed data
 * only (the SDK scrubs before emit; the backend adds no raw data). A minimal
 * SSRF guard requires the URL to be https — the admin owns the URL.
 */

import type { SettingsRepository } from "./types.js";

export const SETTING_WEBHOOK_ENABLED = "webhook.enabled";
export const SETTING_WEBHOOK_URL = "webhook.url";
export const SETTING_WEBHOOK_SECRET = "webhook.secret";

/** Defaults when no tenant override is persisted: disabled, unconfigured. */
export const WEBHOOK_DEFAULTS = {
  enabled: false,
  url: "",
} as const;

/**
 * The full effective webhook config, INCLUDING the secret. Resolved internally
 * for the dispatcher only — it MUST NOT be serialized to any API response or
 * log. The public read endpoint returns `WebhookSettingsView` instead.
 */
export interface WebhookConfig {
  enabled: boolean;
  url: string;
  /** HMAC secret. Server-side only; never returned/logged. */
  secret: string;
}

/** Admin-facing view of the webhook config. The secret is NEVER included. */
export interface WebhookSettingsView {
  enabled: boolean;
  url: string;
  /** True when a (non-empty) secret is configured. The value is never shown. */
  secretConfigured: boolean;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Resolve the full webhook config (secret included) for a tenant. For internal
 * dispatcher use only — never serialize the result.
 */
export async function resolveWebhookConfig(
  settings: SettingsRepository,
  tenantId: string
): Promise<WebhookConfig> {
  const all = await settings
    .getAll(tenantId)
    .catch(() => ({}) as Record<string, string>);
  return {
    enabled: parseBool(all[SETTING_WEBHOOK_ENABLED], WEBHOOK_DEFAULTS.enabled),
    url: (all[SETTING_WEBHOOK_URL] ?? WEBHOOK_DEFAULTS.url).trim(),
    secret: all[SETTING_WEBHOOK_SECRET] ?? "",
  };
}

/** Project the full config to the admin-safe view (drops the secret). */
export function toWebhookSettingsView(config: WebhookConfig): WebhookSettingsView {
  return {
    enabled: config.enabled,
    url: config.url,
    secretConfigured: config.secret.length > 0,
  };
}

/**
 * Whether the webhook is in a dispatchable state: enabled, has an https URL,
 * and has a secret to sign with. Disabled or unconfigured → no dispatch.
 */
export function isWebhookDispatchable(config: WebhookConfig): boolean {
  return (
    config.enabled &&
    isHttpsUrl(config.url) &&
    config.secret.length > 0
  );
}

/**
 * Minimal SSRF guard + validity check: the URL must parse and use https. The
 * admin owns the URL, so we deliberately keep this light (no DNS/CIDR checks),
 * but we refuse plain-http and unparseable values so a misconfig fails loudly.
 */
export function isHttpsUrl(raw: string): boolean {
  if (!raw || raw.trim() === "") return false;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  return u.protocol === "https:";
}
