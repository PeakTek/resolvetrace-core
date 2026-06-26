/**
 * Webhook dispatch for in-app problem reports (feature #5).
 *
 * When `/v1/events` ingests a `support.report_submitted` event, the report is
 * forwarded server-side to the tenant's configured webhook. This module owns:
 *
 *   - assembling the (scrubbed) JSON payload from the event,
 *   - HMAC-SHA256 signing the raw body with the tenant's webhook secret,
 *   - delivering it with a bounded retry/backoff + per-attempt timeout, and
 *   - writing a `webhook.dispatch` audit row for the outcome.
 *
 * Design constraints (Wave-25 brief):
 *   - ASYNC: callers fire-and-forget via `dispatchReportWebhook` so ingest is
 *     never blocked or broken by webhook delivery.
 *   - The secret is server-side only; it is never returned, logged, or placed
 *     in the audit metadata. The audit records status + httpStatus|error +
 *     attempts only.
 *   - Scrubbed data only: the SDK scrubs before emit; we copy fields verbatim
 *     and add no raw data.
 *   - The HTTP client is injectable so unit tests assert on the captured
 *     request (method/url/headers/body) with no real network.
 */

import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import {
  AuditAction,
  recordAudit,
} from "./audit.js";
import type { AuditSink, SettingsRepository, ValidatedEvent } from "./types.js";
import {
  isWebhookDispatchable,
  resolveWebhookConfig,
  type WebhookConfig,
} from "./webhook-settings.js";

/** Header carrying the HMAC-SHA256 signature of the raw request body. */
export const SIGNATURE_HEADER = "X-ResolveTrace-Signature";
/** Header carrying the unix-epoch-seconds timestamp the body was signed at. */
export const TIMESTAMP_HEADER = "X-ResolveTrace-Timestamp";
/** Header marking the event type that triggered the dispatch. */
export const EVENT_HEADER = "X-ResolveTrace-Event";

/** The (scrubbed) JSON body POSTed to the tenant's webhook. */
export interface WebhookReportPayload {
  tenantId: string;
  env: string;
  sessionId: string | null;
  supportCode: string | null;
  description: string | null;
  context: Record<string, unknown> | null;
  recentContext: unknown[];
  occurredAt: string;
}

/** Minimal HTTP response shape the dispatcher needs. */
export interface WebhookHttpResponse {
  status: number;
}

/**
 * Injectable HTTP client. The production implementation wraps `fetch` with an
 * AbortController timeout; tests pass a double that captures the request.
 */
export interface WebhookHttpClient {
  post(input: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<WebhookHttpResponse>;
}

/** Tunables for retry/backoff + timeout. Sane bounded defaults. */
export interface WebhookDispatchPolicy {
  /** Total attempts (initial + retries). Default 3. */
  maxAttempts: number;
  /** Per-attempt request timeout in ms. Default 5000. */
  timeoutMs: number;
  /** Base backoff in ms; attempt N waits ~base * 2^(N-1). Default 200. */
  baseBackoffMs: number;
  /** Cap on a single backoff wait in ms. Default 5000. */
  maxBackoffMs: number;
}

export const DEFAULT_DISPATCH_POLICY: WebhookDispatchPolicy = {
  maxAttempts: 3,
  timeoutMs: 5000,
  baseBackoffMs: 200,
  maxBackoffMs: 5000,
};

/** Sleep helper; injectable for deterministic tests. */
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production HTTP client over `fetch` with a per-attempt abort timeout. A
 * non-2xx response is returned (not thrown) so the caller's retry policy
 * decides; network/abort errors throw and are treated as a failed attempt.
 */
export class FetchWebhookHttpClient implements WebhookHttpClient {
  async post(input: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<WebhookHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const res = await fetch(input.url, {
        method: "POST",
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Compute `sha256=<hex>` HMAC of `body` keyed by `secret`. */
export function signBody(secret: string, body: string): string {
  const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

/**
 * Build the scrubbed payload from a `support.report_submitted` event. The SDK
 * carries the description, support code, and recent-context metadata in the
 * event's (scrubbed) attribute bag (`attributes.description` /
 * `attributes.supportCode` / `attributes.recentContext`); the support code is
 * additionally mirrored onto `context.supportCode` only when the caller
 * supplied a full `EventContext`. We copy verbatim and add no raw data.
 */
export function buildReportPayload(
  tenantId: string,
  env: string,
  event: ValidatedEvent
): WebhookReportPayload {
  const attrs = (event.attributes ?? {}) as Record<string, unknown>;
  const context = (event.context ?? null) as Record<string, unknown> | null;
  const supportCode =
    typeof attrs.supportCode === "string"
      ? attrs.supportCode
      : context && typeof context.supportCode === "string"
        ? context.supportCode
        : null;
  const description =
    typeof attrs.description === "string" ? attrs.description : null;
  const recentContext = Array.isArray(attrs.recentContext)
    ? (attrs.recentContext as unknown[])
    : [];
  return {
    tenantId,
    env,
    sessionId: event.sessionId ?? null,
    supportCode,
    description,
    context,
    recentContext,
    occurredAt: event.capturedAt,
  };
}

export interface DispatchDeps {
  httpClient: WebhookHttpClient;
  auditSink: AuditSink;
  policy?: Partial<WebhookDispatchPolicy>;
  sleep?: SleepFn;
  logger?: Pick<Logger, "error" | "warn" | "info">;
}

/** Result of an attempted delivery. Exposed for the test endpoint + tests. */
export interface DispatchResult {
  status: "delivered" | "failed";
  attempts: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Deliver an already-built payload to a known-dispatchable config, with bounded
 * retry/backoff + per-attempt timeout. Writes a `webhook.dispatch` audit row.
 * Returns the outcome; never throws (delivery failure is a recorded outcome,
 * not an exception that could bubble into ingest).
 */
export async function deliverWebhook(
  deps: DispatchDeps,
  tenantId: string,
  actor: string,
  config: WebhookConfig,
  payload: WebhookReportPayload,
  eventType: string
): Promise<DispatchResult> {
  const policy: WebhookDispatchPolicy = {
    ...DEFAULT_DISPATCH_POLICY,
    ...(deps.policy ?? {}),
  };
  const sleep = deps.sleep ?? realSleep;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signBody(config.secret, body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signature,
    [TIMESTAMP_HEADER]: timestamp,
    [EVENT_HEADER]: eventType,
  };

  let attempts = 0;
  let lastError: string | undefined;
  let lastHttpStatus: number | undefined;

  for (let i = 0; i < policy.maxAttempts; i += 1) {
    attempts += 1;
    try {
      const res = await deps.httpClient.post({
        url: config.url,
        headers,
        body,
        timeoutMs: policy.timeoutMs,
      });
      lastHttpStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        const result: DispatchResult = {
          status: "delivered",
          attempts,
          httpStatus: res.status,
        };
        await writeDispatchAudit(deps, tenantId, actor, payload.sessionId, result);
        return result;
      }
      lastError = `http_${res.status}`;
    } catch (err) {
      lastHttpStatus = undefined;
      lastError = errorLabel(err);
    }

    // Back off before the next attempt (not after the final one).
    if (i < policy.maxAttempts - 1) {
      const backoff = Math.min(
        policy.baseBackoffMs * 2 ** i,
        policy.maxBackoffMs
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoff);
    }
  }

  const result: DispatchResult = {
    status: "failed",
    attempts,
    httpStatus: lastHttpStatus,
    error: lastError ?? "unknown_error",
  };
  await writeDispatchAudit(deps, tenantId, actor, payload.sessionId, result);
  return result;
}

/**
 * Fire-and-forget dispatch entry point used by the events route. Resolves the
 * tenant webhook config, no-ops when disabled/unconfigured, and otherwise
 * delivers the report asynchronously. NEVER throws and NEVER blocks the caller:
 * callers invoke this without awaiting so ingest returns immediately. Any error
 * (including a config-resolve failure) is swallowed + logged.
 */
export function dispatchReportWebhook(
  deps: DispatchDeps & { settingsRepository: SettingsRepository },
  tenantId: string,
  env: string,
  actor: string,
  event: ValidatedEvent
): void {
  // Detach: never let webhook work join the ingest request's lifecycle.
  void (async () => {
    try {
      const config = await resolveWebhookConfig(deps.settingsRepository, tenantId);
      if (!isWebhookDispatchable(config)) {
        // Disabled/unconfigured/non-https → no dispatch, no audit row.
        return;
      }
      const payload = buildReportPayload(tenantId, env, event);
      await deliverWebhook(deps, tenantId, actor, config, payload, event.type);
    } catch (err) {
      // Belt-and-braces: deliverWebhook does not throw, but a resolve failure
      // could. Swallow so ingest is never affected.
      deps.logger?.error(
        { err, tenantId },
        "webhook dispatch failed unexpectedly (non-fatal)"
      );
    }
  })();
}

/** Write the `webhook.dispatch` audit row — never the secret, never the body. */
async function writeDispatchAudit(
  deps: DispatchDeps,
  tenantId: string,
  actor: string,
  sessionId: string | null,
  result: DispatchResult
): Promise<void> {
  const metadata: Record<string, unknown> = {
    sessionId,
    status: result.status,
    attempts: result.attempts,
  };
  if (result.httpStatus !== undefined) metadata.httpStatus = result.httpStatus;
  if (result.error !== undefined) metadata.error = result.error;
  await recordAudit(
    deps.auditSink,
    tenantId,
    {
      actor,
      action: AuditAction.WEBHOOK_DISPATCH,
      targetType: "webhook",
      targetId: sessionId,
      metadata,
    },
    deps.logger
  );
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "timeout";
    return err.name === "Error" ? err.message || "error" : err.name;
  }
  return "error";
}
