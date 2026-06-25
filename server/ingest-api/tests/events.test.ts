import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  AUTH_HEADER,
  validBatch,
  validEvent,
  VALID_ULID_A,
  VALID_ULID_B,
} from "../test-utils/fixtures.js";

describe("POST /v1/events", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("accepts a valid batch with 202 and enqueues the events", async () => {
    const { app, eventSink } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch(),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(typeof body.receivedAt).toBe("string");
    expect(eventSink.size()).toBe(1);
  });

  it("rejects missing Authorization header with 401", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "content-type": "application/json" },
      payload: validBatch(),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects an invalid API key with 401", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer nope",
        "content-type": "application/json",
      },
      payload: validBatch(),
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed body (missing required field) with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: {
        events: [
          {
            // Missing `type`, `capturedAt`, `scrubber`, `sdk`
            eventId: VALID_ULID_A,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_request");
  });

  it("rejects empty events array with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("deduplicates repeat eventIds (idempotency tuple)", async () => {
    const { app, eventSink } = await buildTestApp();
    close = () => app.close();

    const first = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent()]),
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().accepted).toBe(1);

    // Second call with the same eventId — should be counted as a duplicate
    // and NOT enqueued a second time. X-Idempotent-Replay is set.
    const second = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent()]),
    });
    expect(second.statusCode).toBe(202);
    const body = second.json();
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(1);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(eventSink.size()).toBe(1);
  });

  it("accepts the canonical taxonomy + context/severity/durationMs/httpStatus", async () => {
    const { app, eventSink } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({
          eventId: VALID_ULID_A,
          type: "error.api",
          severity: "error",
          httpStatus: 503,
          durationMs: 1284,
          context: {
            releaseVersion: "web@2026.06.1",
            locale: "en-CA",
            market: "ca-retail",
            diagnosticsLevel: "standard",
            routeName: "checkout",
            viewportWidth: 1440,
            viewportHeight: 900,
          },
        }),
        validEvent({ eventId: VALID_ULID_B, type: "checkout.completed" }),
      ]),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(2);
    // size() counts enqueue calls (batches), not events: one POST -> one batch.
    expect(eventSink.size()).toBe(1);
    expect(eventSink.drain()[0].events).toHaveLength(2);
  });

  it("rejects a reserved-namespace shadow type with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      // ux.* is a reserved namespace; ux.totally_made_up is not canonical.
      payload: validBatch([validEvent({ type: "ux.totally_made_up" })]),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects an unsupported schemaVersion major with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent({ schemaVersion: 2 })]),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects a missing schemaVersion with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const evt = validEvent();
    delete (evt as Record<string, unknown>).schemaVersion;
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { events: [evt] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("rejects context missing a required sub-field with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({
          // diagnosticsLevel omitted — required when context present.
          context: {
            releaseVersion: "web@2026.06.1",
            locale: "en-CA",
            market: "ca-retail",
          },
        }),
      ]),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("handles a mixed batch (some fresh, some duplicate)", async () => {
    const { app, eventSink } = await buildTestApp();
    close = () => app.close();

    // Seed one.
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([validEvent({ eventId: VALID_ULID_A })]),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validBatch([
        validEvent({ eventId: VALID_ULID_A }),
        validEvent({ eventId: VALID_ULID_B }),
      ]),
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(1);
    // Expect no X-Idempotent-Replay because the batch wasn't entirely dup.
    expect(res.headers["x-idempotent-replay"]).toBeUndefined();
    expect(eventSink.size()).toBe(2); // one from seed, one fresh now
  });
});
