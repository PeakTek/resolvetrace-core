import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  MockEventRepository,
  MockResolver,
  MockSessionRepository,
} from "../test-utils/mocks.js";
import { AUTH_HEADER, VALID_ULID_SESSION } from "../test-utils/fixtures.js";
import type { EventRecord, SessionRecord } from "../types.js";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: VALID_ULID_SESSION,
    supportCode: "ABCD1234",
    startedAt: "2026-04-20T12:30:00.000Z",
    endedAt: null,
    endedReason: null,
    appVersion: "1.2.3",
    releaseChannel: "stable",
    userAnonId: null,
    eventCount: 4,
    replayChunkCount: null,
    client: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: "01HWZX9KT1N2M3J4P5Q6R7S8A0",
    sessionId: VALID_ULID_SESSION,
    type: "page_view",
    capturedAt: "2026-04-20T12:30:01.000Z",
    attributes: { path: "/home" },
    clockSkewDetected: false,
    ...overrides,
  };
}

describe("GET /api/v1/portal/sessions", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns sessions with the portal-list envelope and null nextCursor when not paginated", async () => {
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-portal-api-version"]).toBe("1");
    const body = res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toEqual({
      sessionId: VALID_ULID_SESSION,
      supportCode: "ABCD1234",
      startedAt: "2026-04-20T12:30:00.000Z",
      endedAt: null,
      eventCount: 4,
      appVersion: "1.2.3",
      releaseChannel: "stable",
    });
    expect(body.nextCursor).toBeNull();
    expect(sessionRepository.lastList?.opts.limit).toBe(50);
    expect(sessionRepository.lastList?.opts.cursor).toBeUndefined();
  });

  it("passes through an opaque cursor and propagates nextCursor", async () => {
    const sessionRepository = new MockSessionRepository(
      [makeSession()],
      "bmV4dC1jdXJzb3I="
    );
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions?limit=10&cursor=YWJj",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBe("bmV4dC1jdXJzb3I=");
    expect(sessionRepository.lastList?.opts.limit).toBe(10);
    expect(sessionRepository.lastList?.opts.cursor).toBe("YWJj");
  });

  it("clamps oversized limit silently to 200 without erroring", async () => {
    const sessionRepository = new MockSessionRepository([]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions?limit=9999",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(sessionRepository.lastList?.opts.limit).toBe(200);
  });

  it("rejects a non-integer limit with 400 invalid_request", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions?limit=-5",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_request");
  });

  it("rejects a cursor with unsupported characters with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions?cursor=has%20space",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_request");
  });

  it("returns 401 when no bearer token is present", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("returns 401 when bearer token does not match OSS_API_KEY or PORTAL_API_TOKEN", async () => {
    const resolver = new MockResolver({
      apiKey: "test-api-key",
      portalApiKey: "portal-token-xyz",
    });
    const { app } = await buildTestApp({ resolver });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the portal token when configured alongside the ingest key", async () => {
    const resolver = new MockResolver({
      apiKey: "test-api-key",
      portalApiKey: "portal-token-xyz",
    });
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const { app } = await buildTestApp({ resolver, sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions",
      headers: { authorization: "Bearer portal-token-xyz" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toHaveLength(1);
  });

  it("enforces the session-class rate limit", async () => {
    const sessionRepository = new MockSessionRepository([]);
    const { app } = await buildTestApp({
      sessionRepository,
      rateLimits: { session: { soft: 1, hard: 2 } },
    });
    close = () => app.close();

    let rateLimited = 0;
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/portal/sessions",
        headers: { authorization: AUTH_HEADER },
      });
      if (res.statusCode === 429) rateLimited += 1;
    }
    expect(rateLimited).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/v1/portal/sessions/:sessionId", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns the session detail envelope with its event list", async () => {
    const session = makeSession();
    const sessionRepository = new MockSessionRepository([session]);
    const eventRepository = new MockEventRepository([makeEvent()]);
    const { app } = await buildTestApp({ sessionRepository, eventRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-portal-api-version"]).toBe("1");
    const body = res.json();
    expect(body.session.sessionId).toBe(VALID_ULID_SESSION);
    expect(body.session.eventCount).toBe(4);
    expect(body.session.appVersion).toBe("1.2.3");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toEqual({
      eventId: "01HWZX9KT1N2M3J4P5Q6R7S8A0",
      type: "page_view",
      capturedAt: "2026-04-20T12:30:01.000Z",
      attributes: { path: "/home" },
    });
    // The scrubber / sdk envelopes are intentionally not surfaced.
    expect(body.events[0].scrubber).toBeUndefined();
    expect(body.events[0].sdk).toBeUndefined();
    expect(body.eventsNextCursor).toBeNull();
    expect(eventRepository.lastCall?.sessionId).toBe(VALID_ULID_SESSION);
    expect(eventRepository.lastCall?.opts.limit).toBe(200);
  });

  it("returns 404 when the session does not exist", async () => {
    const sessionRepository = new MockSessionRepository([]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("not_found");
    expect(body.message).toContain(VALID_ULID_SESSION);
  });

  it("rejects a malformed cursor with 400", async () => {
    const sessionRepository = new MockSessionRepository([makeSession()]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}?cursor=$$$`,
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("returns 401 when no bearer token is present", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/sessions/${VALID_ULID_SESSION}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/v1/portal/sessions/by-support-code/:code", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("resolves a session by its support code", async () => {
    const sessionRepository = new MockSessionRepository([
      makeSession({ supportCode: "ABCD1234" }),
    ]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ABCD1234",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-portal-api-version"]).toBe("1");
    const body = res.json();
    expect(body.session.sessionId).toBe(VALID_ULID_SESSION);
    expect(body.session.supportCode).toBe("ABCD1234");
    expect(sessionRepository.lastFindBySupportCode?.supportCode).toBe(
      "ABCD1234"
    );
  });

  it("normalizes case + dashes/spaces and Crockford I/L/O before lookup", async () => {
    const sessionRepository = new MockSessionRepository([
      makeSession({ supportCode: "ABCD1234" }),
    ]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    // Lowercase, dashed; "abcd-1234" -> "ABCD1234".
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/abcd-1234",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionRepository.lastFindBySupportCode?.supportCode).toBe(
      "ABCD1234"
    );

    // Lenient Crockford look-alikes: I/L -> 1, O -> 0.
    const sessionRepository2 = new MockSessionRepository([
      makeSession({ supportCode: "1B0D1234" }),
    ]);
    const { app: app2 } = await buildTestApp({
      sessionRepository: sessionRepository2,
    });
    const prevClose = close;
    close = async () => {
      await prevClose?.();
      await app2.close();
    };
    const res2 = await app2.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/IBOD1234",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res2.statusCode).toBe(200);
    expect(sessionRepository2.lastFindBySupportCode?.supportCode).toBe(
      "1B0D1234"
    );
  });

  it("returns 404 for an unknown (but well-formed) code", async () => {
    const sessionRepository = new MockSessionRepository([]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ZZZZ9999",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("rejects a malformed code with 400 before hitting the repository", async () => {
    const sessionRepository = new MockSessionRepository([]);
    const { app } = await buildTestApp({ sessionRepository });
    close = () => app.close();

    // "ABC" is too short; "U" is excluded from Crockford.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ABC",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(sessionRepository.lastFindBySupportCode).toBeUndefined();
  });

  it("is tenant-scoped — forwards the principal's tenant to the repository", async () => {
    const resolver = new MockResolver({ tenantId: "tenant-aaa" });
    const sessionRepository = new MockSessionRepository([
      makeSession({ supportCode: "ABCD1234" }),
    ]);
    const { app } = await buildTestApp({ resolver, sessionRepository });
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ABCD1234",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionRepository.lastFindBySupportCode?.tenantId).toBe(
      "tenant-aaa"
    );
  });

  it("returns 401 when no bearer token is present", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/sessions/by-support-code/ABCD1234",
    });
    expect(res.statusCode).toBe(401);
  });
});
