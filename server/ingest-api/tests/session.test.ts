import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  AUTH_HEADER,
  validSessionEnd,
  validSessionStart,
  VALID_ULID_SESSION,
} from "../test-utils/fixtures.js";

describe("POST /v1/session/start", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("opens a session and returns 201", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionStart(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toBe(VALID_ULID_SESSION);
    expect(typeof body.acceptedAt).toBe("string");
    expect(
      sessionSink.getStart("oss-test-tenant", VALID_ULID_SESSION)
    ).toBeDefined();
  });

  it("rejects missing required fields with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { sessionId: VALID_ULID_SESSION }, // missing startedAt
    });
    expect(res.statusCode).toBe(400);
  });

  it("is idempotent on repeat calls", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionStart({ startedAt: "2026-04-20T12:00:00.000Z" }),
    });
    await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionStart({ startedAt: "2026-04-20T13:00:00.000Z" }),
    });
    const stored = sessionSink.getStart("oss-test-tenant", VALID_ULID_SESSION);
    // First-write-wins.
    expect(stored?.startedAt).toBe("2026-04-20T12:00:00.000Z");
  });
});

describe("POST /v1/session/end", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("closes a session and returns 200", async () => {
    const { app, sessionSink } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/end",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionEnd(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(VALID_ULID_SESSION);
    expect(typeof body.acceptedAt).toBe("string");
    expect(
      sessionSink.getEnd("oss-test-tenant", VALID_ULID_SESSION)
    ).toBeDefined();
  });

  it("end without preceding start still returns 200", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/end",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionEnd(),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects invalid `reason` enum with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/session/end",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSessionEnd({ reason: "made_up" }),
    });
    expect(res.statusCode).toBe(400);
  });
});
