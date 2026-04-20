import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import {
  AUTH_HEADER,
  validBatch,
  validEvent,
} from "../test-utils/fixtures.js";

describe("rate limiting", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns 429 with Retry-After + X-RateLimit-* once the burst is exhausted", async () => {
    // Tiny burst budget so the test fires few requests.
    const { app } = await buildTestApp({
      rateLimits: {
        events: { soft: 1, hard: 3 },
      },
    });
    close = () => app.close();

    let firstRateLimited: ReturnType<typeof app.inject> | undefined;
    let acceptedCount = 0;
    let rateLimitedCount = 0;

    // Each event needs a distinct ULID; cheaply generate one by varying char.
    // ULID alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (Crockford).
    const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let i = 0; i < 10; i += 1) {
      const lastChar = ulidAlphabet[i] ?? "0";
      const eventId = `01HWZX9KT1N2M3J4P5Q6R7S8A${lastChar}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: validBatch([validEvent({ eventId })]),
      });
      if (res.statusCode === 202) {
        acceptedCount += 1;
      } else if (res.statusCode === 429) {
        rateLimitedCount += 1;
        if (!firstRateLimited) {
          firstRateLimited = Promise.resolve(res);
        }
      }
    }

    expect(acceptedCount).toBeGreaterThanOrEqual(1);
    expect(rateLimitedCount).toBeGreaterThanOrEqual(1);

    const limited = await firstRateLimited!;
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.headers["x-ratelimit-limit"]).toBeDefined();
    expect(limited.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(limited.headers["x-ratelimit-reset"]).toBeDefined();

    const body = limited.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.class).toBe("events");
    expect(body.scope).toBe("tenant");
    expect(typeof body.retryAfterSeconds).toBe("number");
  });

  it("does not rate-limit /health", async () => {
    const { app } = await buildTestApp({
      rateLimits: {
        events: { soft: 1, hard: 1 },
      },
    });
    close = () => app.close();

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });
});
