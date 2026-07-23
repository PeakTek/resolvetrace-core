/**
 * CORS origin allow-listing — static list + the injected dynamic validator.
 *
 * The validator seam lets a composing server source allowed origins from a
 * registry and change them at runtime (no restart). A CORS preflight carries
 * no credentials, so the decision is by Origin alone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import type { CorsOriginValidator } from "../types.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (close) await close();
  close = undefined;
});

/** A CORS preflight for a cross-origin POST from `origin`. */
function preflight(origin: string) {
  return {
    method: "OPTIONS" as const,
    url: "/v1/events",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  };
}

describe("CORS — dynamic origin validator (injected)", () => {
  const validator: CorsOriginValidator = {
    isAllowed: (origin) => origin === "https://client.example",
  };

  it("reflects an allowed origin on the preflight", async () => {
    const { app } = await buildTestApp({ corsOriginValidator: validator });
    close = () => app.close();

    const res = await app.inject(preflight("https://client.example"));
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://client.example"
    );
  });

  it("withholds the allow-origin header for an unknown origin", async () => {
    const { app } = await buildTestApp({ corsOriginValidator: validator });
    close = () => app.close();

    const res = await app.inject(preflight("https://evil.example"));
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("picks up a runtime change without rebuilding the app", async () => {
    // The validator's decision can change between requests — the origin set is
    // consulted per request, not snapshotted at boot. This is the whole point
    // of the seam (a registry-backed validator updated at runtime).
    const allowed = new Set<string>();
    const dynamic: CorsOriginValidator = { isAllowed: (o) => allowed.has(o) };
    const { app } = await buildTestApp({ corsOriginValidator: dynamic });
    close = () => app.close();

    const before = await app.inject(preflight("https://late.example"));
    expect(before.headers["access-control-allow-origin"]).toBeUndefined();

    allowed.add("https://late.example"); // e.g. an operator registers the origin

    const after = await app.inject(preflight("https://late.example"));
    expect(after.headers["access-control-allow-origin"]).toBe(
      "https://late.example"
    );
  });

  it("supports an async validator", async () => {
    const asyncValidator: CorsOriginValidator = {
      isAllowed: async (o) => o === "https://async.example",
    };
    const { app } = await buildTestApp({ corsOriginValidator: asyncValidator });
    close = () => app.close();

    const res = await app.inject(preflight("https://async.example"));
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://async.example"
    );
  });
});

describe("CORS — static list fallback (no validator)", () => {
  it("reflects an origin in the static allow-list", async () => {
    const { app } = await buildTestApp({
      corsOrigins: ["https://allowed.example"],
    });
    close = () => app.close();

    const res = await app.inject(preflight("https://allowed.example"));
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://allowed.example"
    );
  });

  it("rejects an origin not in the static allow-list", async () => {
    const { app } = await buildTestApp({
      corsOrigins: ["https://allowed.example"],
    });
    close = () => app.close();

    const res = await app.inject(preflight("https://other.example"));
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects any origin when the list is empty (OSS default)", async () => {
    const { app } = await buildTestApp({ corsOrigins: [] });
    close = () => app.close();

    const res = await app.inject(preflight("https://anything.example"));
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://anything.example"
    );
  });
});
