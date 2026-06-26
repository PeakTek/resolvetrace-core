/**
 * Cross-feature integration suite (Wave-26 A3).
 *
 * These tests exercise the SEAMS between the features built across Waves
 * 20–25, composing them through the real Fastify route handlers via
 * `app.inject` — no DB, no network. Where a flow needs ingest data to be
 * visible to the portal read-side, a single `LinkedSessionEventStore` is wired
 * to both the sink and repository slots so the write actually feeds the read.
 *
 * The intent is to prove the features work TOGETHER, not to re-test units:
 *   1. ingest taxonomy/context → persisted → portal session-detail renders it;
 *   2. session-start support code → support-code lookup → session detail;
 *   3. replay signed-url → complete (manifest + counter) → audited read-side
 *      lists + signs each chunk URL;
 *   4. governance composition: audited reads + targeted deletion cascade
 *      (events + replay manifest/objects) + retention purge in one flow;
 *   5. a `support.report_submitted` event → signed, audited webhook dispatch
 *      carrying the support code + scrubbed description + recentContext.
 *
 * Hermetic doubles: `MockStorage` (storage), `CapturingHttpClient` (webhook
 * HTTP). All assertions go through HTTP responses + the in-memory audit sink.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { LinkedSessionEventStore } from "../test-utils/linked-store.js";
import {
  InMemoryAuditSink,
  InMemoryPurgeStore,
  InMemoryReplayManifestStore,
  InMemorySettingsRepository,
} from "../in-memory-sinks.js";
import { loadRetentionConfig } from "../retention-config.js";
import { MockStorage } from "../test-utils/mocks.js";
import { AuditAction } from "../audit.js";
import {
  SETTING_WEBHOOK_ENABLED,
  SETTING_WEBHOOK_SECRET,
  SETTING_WEBHOOK_URL,
} from "../webhook-settings.js";
import {
  SIGNATURE_HEADER,
  EVENT_HEADER,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../webhook-dispatch.js";
import {
  AUTH_HEADER,
  VALID_SHA256,
  VALID_ULID_A,
  VALID_ULID_B,
  VALID_ULID_SESSION,
  validEvent,
} from "../test-utils/fixtures.js";

const TENANT = "oss-test-tenant";

/** Captured-request HTTP double for the webhook seam (no real network). */
class CapturingHttpClient implements WebhookHttpClient {
  public readonly requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }> = [];
  async post(input: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<WebhookHttpResponse> {
    this.requests.push(input);
    return { status: 200 };
  }
}

async function eventually(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function tinyWindows() {
  return loadRetentionConfig({
    RETENTION_EVENTS_DAYS: "7",
    RETENTION_SESSIONS_DAYS: "30",
    RETENTION_REPLAY_DAYS: "7",
  } as NodeJS.ProcessEnv);
}

const json = { "content-type": "application/json" };
const auth = { authorization: AUTH_HEADER, ...json };

describe("integration: ingest taxonomy → persistence → portal session-detail", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("a canonical batch (view/action/error/perf/ux + breadcrumbs + frustration) ingests and reads back with type/context/severity/durationMs/httpStatus", async () => {
    const store = new LinkedSessionEventStore();
    const { app } = await buildTestApp({
      eventSink: store,
      sessionSink: store,
      sessionRepository: store,
      eventRepository: store,
    });
    close = () => app.close();

    const baseContext = {
      releaseVersion: "web@2026.06.1",
      locale: "en-CA",
      market: "ca-retail",
      diagnosticsLevel: "standard" as const,
      routeName: "checkout",
    };

    // Open the session first (mints a support code), then ship a canonical
    // batch spanning the taxonomy: a view, an action, an auto-captured error
    // with severity + httpStatus, a perf event with durationMs, a ux event,
    // a breadcrumb-style action, and a frustration signal.
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: auth,
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
        appVersion: "1.0.0",
      },
    });
    expect(startRes.statusCode).toBe(201);

    const batch = {
      events: [
        validEvent({
          eventId: "01HWZX9KT1N2M3J4P5Q6R7S8C0",
          sessionId: VALID_ULID_SESSION,
          type: "view.start",
          capturedAt: "2026-04-20T12:30:01.000Z",
          context: baseContext,
        }),
        validEvent({
          eventId: "01HWZX9KT1N2M3J4P5Q6R7S8C1",
          sessionId: VALID_ULID_SESSION,
          type: "action.click",
          capturedAt: "2026-04-20T12:30:02.000Z",
          context: baseContext,
        }),
        validEvent({
          eventId: "01HWZX9KT1N2M3J4P5Q6R7S8C2",
          sessionId: VALID_ULID_SESSION,
          type: "error.api",
          severity: "error",
          httpStatus: 503,
          context: baseContext,
          capturedAt: "2026-04-20T12:30:03.000Z",
        }),
        validEvent({
          eventId: "01HWZX9KT1N2M3J4P5Q6R7S8C3",
          sessionId: VALID_ULID_SESSION,
          type: "perf.api_latency",
          durationMs: 2840,
          context: baseContext,
          capturedAt: "2026-04-20T12:30:04.000Z",
        }),
        validEvent({
          eventId: "01HWZX9KT1N2M3J4P5Q6R7S8C4",
          sessionId: VALID_ULID_SESSION,
          type: "ux.rage_click",
          severity: "warn",
          attributes: { clicks: 5, breadcrumbs: ["action.click", "action.click"] },
          context: baseContext,
          capturedAt: "2026-04-20T12:30:05.000Z",
        }),
      ],
    };

    const ingest = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: batch,
    });
    expect(ingest.statusCode).toBe(202);
    expect(ingest.json().accepted).toBe(5);

    // Read the session back through the portal read-side: the events are
    // visible with their canonical-taxonomy fields intact.
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.session.sessionId).toBe(VALID_ULID_SESSION);
    expect(body.session.eventCount).toBe(5);
    expect(body.events).toHaveLength(5);

    const byType = Object.fromEntries(
      body.events.map((e: Record<string, unknown>) => [e.type, e])
    );
    // Type + context preserved on the view event.
    expect(byType["view.start"].context).toMatchObject({
      releaseVersion: "web@2026.06.1",
      routeName: "checkout",
    });
    // Severity + httpStatus on the error event.
    expect(byType["error.api"].severity).toBe("error");
    expect(byType["error.api"].httpStatus).toBe(503);
    // durationMs on the perf event.
    expect(byType["perf.api_latency"].durationMs).toBe(2840);
    // Frustration breadcrumbs carried in attributes; severity surfaced.
    expect(byType["ux.rage_click"].severity).toBe("warn");
    expect(byType["ux.rage_click"].attributes.breadcrumbs).toEqual([
      "action.click",
      "action.click",
    ]);
    // Events come back in capture order.
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      "view.start",
      "action.click",
      "error.api",
      "perf.api_latency",
      "ux.rage_click",
    ]);
  });
});

describe("integration: session-start support code → lookup → session detail", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("mints a code on start, resolves the session by that code, and shows its events", async () => {
    const store = new LinkedSessionEventStore();
    const { app } = await buildTestApp({
      eventSink: store,
      sessionSink: store,
      sessionRepository: store,
      eventRepository: store,
    });
    close = () => app.close();

    // 1. Start mints an 8-char Crockford support code.
    const start = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: auth,
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
        appVersion: "2.1.0",
      },
    });
    expect(start.statusCode).toBe(201);
    const code: string = start.json().supportCode;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    // 2. Ship an event on that session.
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: {
        events: [
          validEvent({
            eventId: VALID_ULID_A,
            sessionId: VALID_ULID_SESSION,
            type: "page_view",
            capturedAt: "2026-04-20T12:30:01.000Z",
          }),
        ],
      },
    });

    // 3. Support-agent flow: paste the code (lower/dashed) → resolves the session.
    const lookup = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/by-support-code/${code.toLowerCase()}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().session.sessionId).toBe(VALID_ULID_SESSION);
    expect(lookup.json().session.supportCode).toBe(code);

    // 4. Drill into the resolved session → its event is shown.
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().session.supportCode).toBe(code);
    expect(detail.json().events.map((e: { eventId: string }) => e.eventId)).toEqual([
      VALID_ULID_A,
    ]);
  });
});

describe("integration: replay upload → manifest/counter → audited read-side", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("signed-url → complete persists a manifest + increments the counter; the read-side lists + signs a chunk URL and audits the access", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const auditSink = new InMemoryAuditSink();
    const { app, storage, purgeStore } = await buildTestApp({
      replayManifestStore,
      auditSink,
    });
    close = () => app.close();

    const key = `${TENANT}/${VALID_ULID_SESSION}/0.rrweb`;

    // 1. Mint a signed upload URL (the storage double records the request).
    const signed = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: auth,
      payload: {
        sessionId: VALID_ULID_SESSION,
        sequence: 0,
        approxBytes: 1024,
        contentType: "application/vnd.resolvetrace.replay+rrweb",
      },
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json().key).toBe(key);
    expect(storage.signedUrlsMinted).toHaveLength(1);

    // 2. Client "uploads" — model that by putting the object in the double —
    //    then completes. Complete persists the manifest + increments counter.
    storage.putObject(key, { size: 1024, sha256: VALID_SHA256 });
    const complete = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: auth,
      payload: {
        sessionId: VALID_ULID_SESSION,
        sequence: 0,
        key,
        bytes: 1024,
        sha256: VALID_SHA256,
        clientUploadedAt: "2026-04-20T12:35:00.000Z",
        scrubber: {
          version: "sdk@0.1.0",
          rulesDigest: `sha256:${VALID_SHA256}`,
          applied: ["maskAllInputs"],
          budgetExceeded: false,
        },
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().durable).toBe(true);

    // Manifest row persisted; counter incremented via the linked purge store.
    expect(
      await replayManifestStore.listBySession(TENANT, VALID_ULID_SESSION)
    ).toHaveLength(1);
    expect(
      await purgeStore.listReplayManifestKeys(TENANT, VALID_ULID_SESSION)
    ).toEqual([key]);

    // 3. Read-side: lists the manifest, signs a GET URL per chunk, audits it.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}/replay`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.chunkCount).toBe(1);
    expect(body.chunks[0].url).toContain(key);
    expect(body.chunks[0].scrubber).toMatchObject({ version: "sdk@0.1.0" });

    // Signed GET minted via the storage double for the chunk.
    expect(storage.downloadUrlsMinted.map((d) => d.key)).toEqual([key]);

    // The read wrote a replay.access audit row.
    const access = auditSink
      .all(TENANT)
      .filter((r) => r.action === AuditAction.REPLAY_ACCESS);
    expect(access).toHaveLength(1);
    expect(access[0]!.targetId).toBe(VALID_ULID_SESSION);
    expect(access[0]!.metadata).toMatchObject({ chunkCount: 1 });
  });
});

describe("integration: governance composition (audit + cascade delete + retention purge)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("an audited read, then a targeted deletion cascading events+replay manifest/objects, then a retention purge — across feature tables in one flow", async () => {
    // Shared, linked stores so a deletion in one feature is observable in the
    // others: the manifest store backs the purge store's replay-key lookups,
    // and the purge store is seeded to mirror what ingest persisted.
    const manifest = new InMemoryReplayManifestStore();
    const purgeStore = new InMemoryPurgeStore(manifest);
    const auditSink = new InMemoryAuditSink();
    const storage = new MockStorage();
    const { app } = await buildTestApp({
      purgeStore,
      replayManifestStore: manifest,
      auditSink,
      storage,
      retentionConfig: tinyWindows(),
    });
    close = () => app.close();

    // Two sessions: "target" (to be erased now) and "stale" (45d old, purged
    // by retention). Both carry replay chunks recorded in the manifest.
    purgeStore.seedSessions(TENANT, [
      { sessionId: "target", startedAt: daysAgo(1), replayChunkCount: 2 },
      { sessionId: "stale", startedAt: daysAgo(45), replayChunkCount: 1 },
    ]);
    purgeStore.seedEvents(TENANT, [
      { eventId: "t-e1", sessionId: "target", capturedAt: daysAgo(1) },
      { eventId: "t-e2", sessionId: "target", capturedAt: daysAgo(1) },
      { eventId: "s-e1", sessionId: "stale", capturedAt: daysAgo(45) },
    ]);
    await manifest.recordChunk(TENANT, {
      sessionId: "target",
      sequence: 0,
      key: `${TENANT}/target/0.rrweb`,
      bytes: 100,
      sha256: "a".repeat(64),
    });
    await manifest.recordChunk(TENANT, {
      sessionId: "target",
      sequence: 1,
      key: `${TENANT}/target/1.rrweb`,
      bytes: 200,
      sha256: "b".repeat(64),
    });
    await manifest.recordChunk(TENANT, {
      sessionId: "stale",
      sequence: 0,
      key: `${TENANT}/stale/0.rrweb`,
      bytes: 50,
      sha256: "c".repeat(64),
    });

    // 1. A sensitive read: the replay read-side writes a replay.access audit
    //    row for the target session.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/target/replay`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().chunkCount).toBe(2);
    expect(
      auditSink.all(TENANT).filter((r) => r.action === AuditAction.REPLAY_ACCESS)
    ).toHaveLength(1);

    // 2. Targeted deletion (right-to-erasure): cascades events + replay
    //    manifest rows + storage objects, and writes a session.delete audit.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/portal/sessions/target`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toMatchObject({
      sessionId: "target",
      eventsDeleted: 2,
      replayObjects: 2,
    });
    // Cascade across feature tables: session row gone, events gone, manifest
    // rows gone, storage objects deleted.
    expect(purgeStore.sessionsFor(TENANT).map((s) => s.sessionId)).toEqual([
      "stale",
    ]);
    expect(purgeStore.eventsFor(TENANT).map((e) => e.eventId)).toEqual(["s-e1"]);
    expect(await manifest.listBySession(TENANT, "target")).toHaveLength(0);
    expect(storage.deleted).toEqual([
      `${TENANT}/target/0.rrweb`,
      `${TENANT}/target/1.rrweb`,
    ]);
    const deleteRow = auditSink
      .all(TENANT)
      .find((r) => r.action === AuditAction.SESSION_DELETE)!;
    expect(deleteRow.targetId).toBe("target");

    // 3. Retention purge: removes the past-window "stale" session + its event +
    //    its replay objects/manifest, and writes a retention.purge audit row.
    const purge = await app.inject({
      method: "POST",
      url: "/api/v1/portal/retention/purge",
      headers: { authorization: AUTH_HEADER },
    });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().purged).toMatchObject({
      sessions: 1,
      events: 1,
      replayObjects: 1,
    });
    // Everything is now gone across all feature tables.
    expect(purgeStore.sessionsFor(TENANT)).toHaveLength(0);
    expect(purgeStore.eventsFor(TENANT)).toHaveLength(0);
    expect(await manifest.listBySession(TENANT, "stale")).toHaveLength(0);
    expect(storage.deleted).toContain(`${TENANT}/stale/0.rrweb`);
    expect(
      auditSink.all(TENANT).filter((r) => r.action === AuditAction.RETENTION_PURGE)
    ).toHaveLength(1);

    // The audit trail captured all three governance actions in order.
    expect(
      auditSink
        .all(TENANT)
        .map((r) => r.action)
        .filter((a) =>
          [
            AuditAction.REPLAY_ACCESS,
            AuditAction.SESSION_DELETE,
            AuditAction.RETENTION_PURGE,
          ].includes(a as never)
        )
    ).toEqual([
      AuditAction.REPLAY_ACCESS,
      AuditAction.SESSION_DELETE,
      AuditAction.RETENTION_PURGE,
    ]);
  });
});

describe("integration: report submission → signed, audited webhook dispatch", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("a support.report_submitted event carrying a session's support code triggers a signed dispatch with the scrubbed description + recentContext, audited", async () => {
    const store = new LinkedSessionEventStore();
    const httpClient = new CapturingHttpClient();
    const settingsRepository = new InMemorySettingsRepository();
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_ENABLED, "true");
    await settingsRepository.set(
      TENANT,
      SETTING_WEBHOOK_URL,
      "https://hooks.example.test/ingest"
    );
    const SECRET = "whsec_integration_0123456789ab";
    await settingsRepository.set(TENANT, SETTING_WEBHOOK_SECRET, SECRET);
    const auditSink = new InMemoryAuditSink();

    const { app } = await buildTestApp({
      eventSink: store,
      sessionSink: store,
      sessionRepository: store,
      eventRepository: store,
      settingsRepository,
      auditSink,
      webhookHttpClient: httpClient,
      webhookDispatchPolicy: { baseBackoffMs: 1 },
    });
    close = () => app.close();

    // 1. Start a session → real support code (the seam: the report carries it).
    const start = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: auth,
      payload: {
        sessionId: VALID_ULID_SESSION,
        startedAt: "2026-04-20T12:30:00.000Z",
      },
    });
    const supportCode: string = start.json().supportCode;

    // 2. The user submits a problem report on that session.
    const report = validEvent({
      eventId: VALID_ULID_B,
      sessionId: VALID_ULID_SESSION,
      type: "support.report_submitted",
      context: {
        releaseVersion: "web@2026.06.1",
        locale: "en-CA",
        market: "ca-retail",
        diagnosticsLevel: "assisted_support",
        routeName: "support",
        supportCode,
      },
      attributes: {
        category: "payment_failed",
        description: "Checkout button does nothing",
        supportCode,
        recentContext: [{ type: "action.click", at: "2026-04-20T12:34:50.000Z" }],
      },
    });
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth,
      payload: { events: [report] },
    });
    expect(ingest.statusCode).toBe(202);

    // 3. The webhook dispatched (fire-and-forget, post-response).
    await eventually(() => httpClient.requests.length === 1);
    const req = httpClient.requests[0]!;
    expect(req.url).toBe("https://hooks.example.test/ingest");
    expect(req.headers[EVENT_HEADER]).toBe("support.report_submitted");

    // HMAC-SHA256 signature verifies over the raw body with the tenant secret.
    const sig = req.headers[SIGNATURE_HEADER];
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update(req.body, "utf8").digest("hex");
    expect(sig).toBe(expected);

    // Payload carries the session's support code + scrubbed description +
    // recentContext — and the support code matches what start minted.
    const payload = JSON.parse(req.body);
    expect(payload.sessionId).toBe(VALID_ULID_SESSION);
    expect(payload.supportCode).toBe(supportCode);
    expect(payload.description).toBe("Checkout button does nothing");
    expect(payload.recentContext).toEqual([
      { type: "action.click", at: "2026-04-20T12:34:50.000Z" },
    ]);

    // 4. A webhook.dispatch audit row records the delivery — never the secret.
    await eventually(() =>
      auditSink.all(TENANT).some((r) => r.action === AuditAction.WEBHOOK_DISPATCH)
    );
    const row = auditSink
      .all(TENANT)
      .find((r) => r.action === AuditAction.WEBHOOK_DISPATCH)!;
    expect(row.metadata).toMatchObject({
      sessionId: VALID_ULID_SESSION,
      status: "delivered",
      httpStatus: 200,
    });
    expect(JSON.stringify(row.metadata)).not.toContain(SECRET);

    // The report is also persisted + visible on the session detail (the seam
    // between ingest and the portal read-side still holds for report events).
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(
      detail.json().events.some(
        (e: { type: string }) => e.type === "support.report_submitted"
      )
    ).toBe(true);
  });
});
