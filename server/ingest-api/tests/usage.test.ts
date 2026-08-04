/**
 * Portal usage route — GET /api/v1/portal/usage.
 *
 * Admin-gated (tenant:admin); tenant-scoped from the principal; returns this
 * calendar month's distinct replay sessions + GB-month, and passes any
 * composing-server annotation rows through opaquely.
 */

import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { MockResolver } from "../test-utils/mocks.js";
import { AUTH_HEADER } from "../test-utils/fixtures.js";
import { InMemoryReplayManifestStore } from "../in-memory-sinks.js";
import { loadRetentionConfig } from "../retention-config.js";

const TENANT = "oss-test-tenant";

/** Retention fixed at 30d so GB-month == GB stored (period-length independent). */
function replay30d() {
  return loadRetentionConfig({
    RETENTION_REPLAY_DAYS: "30",
  } as NodeJS.ProcessEnv);
}

async function seedChunk(
  store: InMemoryReplayManifestStore,
  sessionId: string,
  sequence: number,
  bytes: number
): Promise<void> {
  await store.recordChunk(TENANT, {
    sessionId,
    sequence,
    key: `${TENANT}/${sessionId}/${sequence}.rrweb`,
    bytes,
    sha256: "0".repeat(64),
  });
}

describe("GET /api/v1/portal/usage", () => {
  it("returns this month's replay sessions + GB-month for an admin", async () => {
    const store = new InMemoryReplayManifestStore();
    // 2 distinct sessions, 0.5 GB total across 3 chunks.
    await seedChunk(store, "sess-a", 0, 300_000_000);
    await seedChunk(store, "sess-a", 1, 100_000_000);
    await seedChunk(store, "sess-b", 0, 100_000_000);

    const { app } = await buildTestApp({
      replayManifestStore: store,
      retentionConfig: replay30d(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/usage",
      headers: { authorization: AUTH_HEADER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.replaySessions).toBe(2);
    expect(body.bytes).toBe(500_000_000);
    expect(body.gbMonth).toBeCloseTo(0.5, 6); // 0.5 GB × 30/30
    expect(body.annotations).toBeNull();
    expect(typeof body.periodStart).toBe("string");
    expect(typeof body.periodEnd).toBe("string");
    await app.close();
  });

  it("returns 403 for a non-admin (no tenant:admin scope)", async () => {
    const { app } = await buildTestApp({
      resolver: new MockResolver({ scopes: ["session:read"] }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/usage",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("passes composing-server annotations through opaquely when injected", async () => {
    const rows = [
      { label: "Plan", value: "Pro" },
      { label: "Included", value: "20000 sessions · 100 GB-month" },
    ];
    const { app } = await buildTestApp({
      usageAnnotations: { get: async () => rows },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/usage",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().annotations).toEqual(rows);
    await app.close();
  });
});
