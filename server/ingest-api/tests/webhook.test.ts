/**
 * Webhook dispatch + tenant config (feature #5, in-app problem reporting).
 *
 * Covers:
 *   - a `support.report_submitted` event triggers a signed dispatch;
 *   - the HMAC-SHA256 signature is correct + independently verifiable;
 *   - bounded retry on failure + per-attempt timeout;
 *   - disabled / unconfigured / non-https → no dispatch;
 *   - dispatch never blocks or breaks ingest;
 *   - a `webhook.dispatch` audit row is written (success + failure);
 *   - the secret is never returned or logged;
 *   - RBAC: settings + test are admin-only (viewer 403).
 *
 * All HTTP is via an injected captured-request double — no real network.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  AUTH_HEADER,
  validBatch,
  validEvent,
  VALID_ULID_A,
  VALID_ULID_SESSION,
} from "../test-utils/fixtures.js";
import { MockResolver } from "../test-utils/mocks.js";
import { InMemoryAuditSink, InMemorySettingsRepository } from "../in-memory-sinks.js";
import {
  SETTING_WEBHOOK_ENABLED,
  SETTING_WEBHOOK_SECRET,
  SETTING_WEBHOOK_URL,
} from "../webhook-settings.js";
import {
  buildReportPayload,
  signBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  EVENT_HEADER,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../webhook-dispatch.js";

const TENANT = "oss-test-tenant";
const WEBHOOK_URL = "https://hooks.example.test/ingest";
const SECRET = "whsec_test_0123456789abcdef";

/** Captured-request HTTP double. Records every POST; returns a scripted status. */
class CapturingHttpClient implements WebhookHttpClient {
  public readonly requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }> = [];
  /** Sequence of behaviours per attempt; the last is reused after exhaustion. */
  private readonly script: Array<number | "throw" | "timeout">;
  constructor(script: Array<number | "throw" | "timeout"> = [200]) {
    this.script = script;
  }
  async post(input: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<WebhookHttpResponse> {
    this.requests.push(input);
    const idx = Math.min(this.requests.length - 1, this.script.length - 1);
    const beh = this.script[idx];
    if (beh === "throw") throw new Error("ECONNREFUSED");
    if (beh === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return { status: beh };
  }
}

/** A report event carrying scrubbed description + breadcrumbs + support code. */
function reportEvent(overrides: Record<string, unknown> = {}) {
  return validEvent({
    eventId: VALID_ULID_A,
    sessionId: VALID_ULID_SESSION,
    type: "support.report_submitted",
    context: {
      releaseVersion: "web@2026.06.1",
      locale: "en-CA",
      market: "ca-retail",
      diagnosticsLevel: "assisted_support",
      routeName: "support",
      supportCode: "RT-7Q4K2",
    },
    attributes: {
      category: "payment_failed",
      description: "Checkout button does nothing",
      recentBreadcrumbs: [
        { type: "action.click", at: "2026-04-20T12:34:50.000Z" },
      ],
    },
    ...overrides,
  });
}

/** Seed a fully-configured, enabled webhook for the default tenant. */
function configuredSettings(): InMemorySettingsRepository {
  const s = new InMemorySettingsRepository();
  void s.set(TENANT, SETTING_WEBHOOK_ENABLED, "true");
  void s.set(TENANT, SETTING_WEBHOOK_URL, WEBHOOK_URL);
  void s.set(TENANT, SETTING_WEBHOOK_SECRET, SECRET);
  return s;
}

/** Poll until `fn()` is truthy (dispatch is fire-and-forget / post-response). */
async function eventually(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("webhook dispatch on support.report_submitted", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("dispatches a signed request whose HMAC verifies", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const settingsRepository = configuredSettings();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { baseBackoffMs: 1 },
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });
    expect(res.statusCode).toBe(202);

    await eventually(() => httpClient.requests.length === 1);
    const req = httpClient.requests[0];
    expect(req.url).toBe(WEBHOOK_URL);

    // Signature header is sha256=<hex> and verifies over the raw body.
    const sig = req.headers[SIGNATURE_HEADER];
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update(req.body, "utf8").digest("hex");
    expect(sig).toBe(expected);
    expect(req.headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(req.headers[EVENT_HEADER]).toBe("support.report_submitted");

    // Payload is the scrubbed report shape.
    const payload = JSON.parse(req.body);
    expect(payload.tenantId).toBe(TENANT);
    expect(payload.env).toBe("dev");
    expect(payload.sessionId).toBe(VALID_ULID_SESSION);
    expect(payload.supportCode).toBe("RT-7Q4K2");
    expect(payload.description).toBe("Checkout button does nothing");
    expect(payload.recentBreadcrumbs).toHaveLength(1);
    expect(payload.occurredAt).toBeDefined();

    // A success audit row was written.
    await eventually(() =>
      auditSink.all(TENANT).some((r) => r.action === "webhook.dispatch")
    );
    const row = auditSink.all(TENANT).find((r) => r.action === "webhook.dispatch")!;
    expect(row.targetType).toBe("webhook");
    expect(row.metadata).toMatchObject({
      sessionId: VALID_ULID_SESSION,
      status: "delivered",
      httpStatus: 200,
      attempts: 1,
    });
    // Secret never appears in the audit metadata.
    expect(JSON.stringify(row.metadata)).not.toContain(SECRET);
  });

  it("retries on failure (bounded) and audits the failure", async () => {
    // Two 500s then success → 3 attempts, delivered.
    const httpClient = new CapturingHttpClient([500, 500, 200]);
    const settingsRepository = configuredSettings();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 2 },
    });
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });

    await eventually(() => httpClient.requests.length === 3);
    await eventually(() =>
      auditSink.all(TENANT).some((r) => r.action === "webhook.dispatch")
    );
    const row = auditSink.all(TENANT).find((r) => r.action === "webhook.dispatch")!;
    expect(row.metadata).toMatchObject({ status: "delivered", attempts: 3 });
  });

  it("caps attempts and records a failed dispatch when all attempts fail", async () => {
    const httpClient = new CapturingHttpClient(["throw"]);
    const settingsRepository = configuredSettings();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 2 },
    });
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });

    await eventually(() => httpClient.requests.length === 3);
    // Bounded — never exceeds maxAttempts.
    await new Promise((r) => setTimeout(r, 30));
    expect(httpClient.requests.length).toBe(3);

    await eventually(() =>
      auditSink.all(TENANT).some((r) => r.action === "webhook.dispatch")
    );
    const row = auditSink.all(TENANT).find((r) => r.action === "webhook.dispatch")!;
    expect(row.metadata).toMatchObject({ status: "failed", attempts: 3 });
    expect((row.metadata as Record<string, unknown>).error).toBeDefined();
  });

  it("passes a per-attempt timeout to the HTTP client", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const { app } = await buildTestApp({
      settingsRepository: configuredSettings(),
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { timeoutMs: 1234, baseBackoffMs: 1 },
    });
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });
    await eventually(() => httpClient.requests.length === 1);
    expect(httpClient.requests[0].timeoutMs).toBe(1234);
  });

  it("does NOT dispatch when the webhook is disabled", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const settingsRepository = new InMemorySettingsRepository();
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_ENABLED, "false");
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_URL, WEBHOOK_URL);
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_SECRET, SECRET);
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });
    expect(res.statusCode).toBe(202);

    await new Promise((r) => setTimeout(r, 40));
    expect(httpClient.requests.length).toBe(0);
    expect(
      auditSink.all(TENANT).some((r) => r.action === "webhook.dispatch")
    ).toBe(false);
  });

  it("does NOT dispatch when the webhook is unconfigured (no url/secret)", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const settingsRepository = new InMemorySettingsRepository();
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_ENABLED, "true");
    const { app } = await buildTestApp({
      settingsRepository,
      webhookHttpClient: httpClient,
    });
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(httpClient.requests.length).toBe(0);
  });

  it("does NOT dispatch for non-report event types", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const { app } = await buildTestApp({
      settingsRepository: configuredSettings(),
      webhookHttpClient: httpClient,
    });
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent({ type: "page_view" })]),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(httpClient.requests.length).toBe(0);
  });

  it("ingest still succeeds (202) even when dispatch fails hard", async () => {
    const httpClient = new CapturingHttpClient(["throw"]);
    const { app, eventSink } = await buildTestApp({
      settingsRepository: configuredSettings(),
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1 },
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([reportEvent()]),
    });
    // Report event persisted normally; the failing webhook did not break it.
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
    expect(eventSink.size()).toBe(1);
  });

  it("does not re-dispatch a duplicate report event", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const { app } = await buildTestApp({
      settingsRepository: configuredSettings(),
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { baseBackoffMs: 1 },
    });
    close = () => app.close();

    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
        payload: validBatch([reportEvent()]),
      });
    await send();
    await eventually(() => httpClient.requests.length === 1);
    // Same eventId again → deduped, not re-dispatched.
    await send();
    await new Promise((r) => setTimeout(r, 40));
    expect(httpClient.requests.length).toBe(1);
  });
});

describe("buildReportPayload", () => {
  it("extracts description/breadcrumbs/supportCode and adds no raw data", () => {
    const payload = buildReportPayload(TENANT, "prod", reportEvent());
    expect(payload).toEqual({
      tenantId: TENANT,
      env: "prod",
      sessionId: VALID_ULID_SESSION,
      supportCode: "RT-7Q4K2",
      description: "Checkout button does nothing",
      context: expect.objectContaining({ supportCode: "RT-7Q4K2" }),
      recentBreadcrumbs: [
        { type: "action.click", at: "2026-04-20T12:34:50.000Z" },
      ],
      occurredAt: expect.any(String),
    });
  });

  it("tolerates a report with no attributes/context", () => {
    const evt = validEvent({ type: "support.report_submitted" });
    delete (evt as Record<string, unknown>).attributes;
    const payload = buildReportPayload(TENANT, "dev", evt);
    expect(payload.description).toBeNull();
    expect(payload.supportCode).toBeNull();
    expect(payload.recentBreadcrumbs).toEqual([]);
  });
});

describe("signBody", () => {
  it("produces a stable, verifiable sha256= hex HMAC", () => {
    const body = JSON.stringify({ a: 1, b: "two" });
    const sig = signBody(SECRET, body);
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(sig).toBe(expected);
  });
});

describe("GET/PUT /api/v1/portal/settings/webhook (RBAC + secret hygiene)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("GET returns the view without the secret; reports secretConfigured", async () => {
    const settingsRepository = configuredSettings();
    const { app } = await buildTestApp({ settingsRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/settings/webhook",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.webhook).toEqual({
      enabled: true,
      url: WEBHOOK_URL,
      secretConfigured: true,
    });
    // The secret value is never present anywhere in the response.
    expect(res.body).not.toContain(SECRET);
  });

  it("PUT persists url/secret/enabled, audits, never returns the secret", async () => {
    const settingsRepository = new InMemorySettingsRepository();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({ settingsRepository, auditSink });
    close = () => app.close();

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/webhook",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { enabled: true, url: WEBHOOK_URL, secret: SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().webhook.secretConfigured).toBe(true);

    // Secret persisted (resolvable internally) but never surfaced.
    const stored = await settingsRepository.getAll(TENANT);
    expect(stored[SETTING_WEBHOOK_SECRET]).toBe(SECRET);

    // Audit row records the change without the secret value.
    const row = auditSink
      .all(TENANT)
      .find((r) => r.action === "settings.update" && r.targetType === "webhook")!;
    expect(row).toBeDefined();
    expect(JSON.stringify(row.metadata)).not.toContain(SECRET);
    expect(row.metadata).toMatchObject({
      webhook: { enabled: true, url: WEBHOOK_URL, secret: "set" },
    });
  });

  it("PUT rejects a non-https url with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/webhook",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { url: "http://insecure.example.test/hook" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("GET is 403 for a viewer principal (no audit:read scope)", async () => {
    const resolver = new MockResolver({
      scopes: ["events:write", "replay:write", "session:read"],
    });
    const { app } = await buildTestApp({ resolver });
    close = () => app.close();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/settings/webhook",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PUT is 403 for a viewer principal", async () => {
    const resolver = new MockResolver({
      scopes: ["events:write", "replay:write", "session:read"],
    });
    const { app } = await buildTestApp({ resolver });
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/webhook",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/v1/portal/settings/webhook/test", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("sends a signed sample and returns the delivery result + audits it", async () => {
    const httpClient = new CapturingHttpClient([200]);
    const settingsRepository = configuredSettings();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { baseBackoffMs: 1 },
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/settings/webhook/test",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ status: "delivered", httpStatus: 200 });

    expect(httpClient.requests.length).toBe(1);
    const sig = httpClient.requests[0].headers[SIGNATURE_HEADER];
    const expected =
      "sha256=" +
      createHmac("sha256", SECRET)
        .update(httpClient.requests[0].body, "utf8")
        .digest("hex");
    expect(sig).toBe(expected);
    expect(res.body).not.toContain(SECRET);

    expect(
      auditSink.all(TENANT).some((r) => r.action === "webhook.dispatch")
    ).toBe(true);
  });

  it("returns 400 when url/secret are not configured", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/settings/webhook/test",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 502 when delivery fails", async () => {
    const httpClient = new CapturingHttpClient(["throw"]);
    const { app } = await buildTestApp({
      settingsRepository: configuredSettings(),
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { maxAttempts: 1, baseBackoffMs: 1 },
    });
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/settings/webhook/test",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().result.status).toBe("failed");
  });

  it("is 403 for a viewer principal", async () => {
    const resolver = new MockResolver({
      scopes: ["events:write", "replay:write", "session:read"],
    });
    const { app } = await buildTestApp({
      resolver,
      settingsRepository: configuredSettings(),
    });
    close = () => app.close();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/portal/settings/webhook/test",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(403);
  });
});
