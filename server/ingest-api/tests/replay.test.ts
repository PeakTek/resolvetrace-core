import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { MockResolver } from "../test-utils/mocks.js";
import { InMemoryReplayManifestStore } from "../in-memory-sinks.js";
import { isReplayAllowed } from "../replay-settings.js";
import {
  AUTH_HEADER,
  VALID_SHA256,
  VALID_ULID_SESSION,
  validManifestRequest,
  validSignedUrlRequest,
} from "../test-utils/fixtures.js";

describe("POST /v1/replay/signed-url", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("mints a signed URL and returns 201 with key + headers", async () => {
    const { app, storage } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSignedUrlRequest(),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.uploadUrl).toMatch(/^https?:\/\//);
    expect(body.key).toBe(`oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`);
    expect(typeof body.expiresAt).toBe("string");
    expect(body.maxBytes).toBe(1024);
    expect(body.requiredHeaders["Content-Type"]).toBe(
      "application/vnd.resolvetrace.replay+rrweb"
    );
    expect(storage.signedUrlsMinted).toHaveLength(1);
  });

  it("rejects invalid content type with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSignedUrlRequest({ contentType: "text/plain" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing auth with 401", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: { "content-type": "application/json" },
      payload: validSignedUrlRequest(),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/replay/complete", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("accepts matching manifest with 200 when sha256 matches", async () => {
    const { app, storage } = await buildTestApp();
    close = () => app.close();

    const expectedKey = `oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`;
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(VALID_ULID_SESSION);
    expect(body.sequence).toBe(0);
    expect(body.durable).toBe(true);
  });

  it("accepts manifest when backend reports null checksum (size-only verify)", async () => {
    const { app, storage } = await buildTestApp();
    close = () => app.close();

    const expectedKey = `oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`;
    storage.putObject(expectedKey, { size: 1024, sha256: null });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects manifest with mismatched sha256 with 409", async () => {
    const { app, storage } = await buildTestApp();
    close = () => app.close();

    const expectedKey = `oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`;
    storage.putObject(expectedKey, {
      size: 1024,
      sha256: "a".repeat(64),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("integrity_check_failed");
  });

  it("rejects manifest with wrong byte length with 409", async () => {
    const { app, storage } = await buildTestApp();
    close = () => app.close();

    const expectedKey = `oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`;
    storage.putObject(expectedKey, { size: 2048, sha256: VALID_SHA256 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest({ bytes: 1024 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("integrity_check_failed");
  });

  it("rejects manifest with key pointing at another tenant with 400", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest({
        key: `other-tenant/${VALID_ULID_SESSION}/0.rrweb`,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("key_mismatch");
  });

  it("rejects manifest for missing object with 409", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    // Note: no putObject call — the storage is empty.
    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("stage1_precondition_failed");
  });

  // Regression: a deployment's TenantConfigResolver may issue uppercase
  // Crockford-ULID tenant ids. CHUNK_KEY_PATTERN used to allow only lowercase
  // slugs in the tenant segment, so signed-url minted a key that complete
  // itself then rejected with key_format (400) on every such deployment.
  it("accepts manifest when the tenant id is an uppercase ULID", async () => {
    const ULID_TENANT = "01KWQJPEAPD44FYXYNHJR1B1HH";
    const { app, storage } = await buildTestApp({
      resolver: new MockResolver({ tenantId: ULID_TENANT }),
    });
    close = () => app.close();

    const expectedKey = `${ULID_TENANT}/${VALID_ULID_SESSION}/0.rrweb`;
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest({ key: expectedKey }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().durable).toBe(true);
  });
});

describe("POST /v1/replay/complete — manifest persistence (Wave-24)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  const TENANT = "oss-test-tenant";
  const expectedKey = `${TENANT}/${VALID_ULID_SESSION}/0.rrweb`;

  it("persists a manifest row, records the scrubber, and increments the counter", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const { app, storage, purgeStore } = await buildTestApp({
      replayManifestStore,
    });
    close = () => app.close();
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const res = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().durable).toBe(true);

    // Manifest row persisted with key, bytes, sha256, and the scrubber report.
    const rows = await replayManifestStore.listBySession(
      TENANT,
      VALID_ULID_SESSION
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sequence).toBe(0);
    expect(rows[0]!.key).toBe(expectedKey);
    expect(rows[0]!.bytes).toBe(1024);
    expect(rows[0]!.sha256).toBe(VALID_SHA256);
    expect(rows[0]!.scrubber).toMatchObject({
      version: "sdk@0.1.0",
      budgetExceeded: false,
    });
    expect(rows[0]!.clientUploadedAt).toBe("2026-04-20T12:35:00.000Z");

    // Counter incremented via the linked purge store (manifest key is now the
    // authoritative purge source).
    expect(
      await purgeStore.listReplayManifestKeys(TENANT, VALID_ULID_SESSION)
    ).toEqual([expectedKey]);
  });

  it("is idempotent on a repeated sequence (no duplicate row, single increment)", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const { app, storage } = await buildTestApp({ replayManifestStore });
    close = () => app.close();
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const first = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(first.statusCode).toBe(200);
    const firstRes = await replayManifestStore.recordChunk(TENANT, {
      sessionId: VALID_ULID_SESSION,
      sequence: 0,
      key: expectedKey,
      bytes: 1024,
      sha256: VALID_SHA256,
    });
    // The second recordChunk for the same sequence reports inserted=false.
    expect(firstRes.inserted).toBe(false);

    // Re-POST the same sequence: still 200, still a single manifest row.
    const second = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(second.statusCode).toBe(200);
    const rows = await replayManifestStore.listBySession(
      TENANT,
      VALID_ULID_SESSION
    );
    expect(rows).toHaveLength(1);
  });

  it("persists distinct rows for distinct sequences", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const { app, storage } = await buildTestApp({ replayManifestStore });
    close = () => app.close();
    const k0 = `${TENANT}/${VALID_ULID_SESSION}/0.rrweb`;
    const k1 = `${TENANT}/${VALID_ULID_SESSION}/1.rrweb`;
    storage.putObject(k0, { size: 1024, sha256: VALID_SHA256 });
    storage.putObject(k1, { size: 1024, sha256: VALID_SHA256 });

    await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest({ sequence: 0, key: k0 }),
    });
    await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest({ sequence: 1, key: k1 }),
    });

    const rows = await replayManifestStore.listBySession(
      TENANT,
      VALID_ULID_SESSION
    );
    expect(rows.map((r) => r.sequence)).toEqual([0, 1]);
  });
});

describe("replay policy enforcement (Wave-24)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  const TENANT = "oss-test-tenant";
  const expectedKey = `${TENANT}/${VALID_ULID_SESSION}/0.rrweb`;

  it("rejects signed-url + complete with 403 when replay is disabled for the tenant", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const { app, storage, settingsRepository } = await buildTestApp({
      replayManifestStore,
    });
    close = () => app.close();
    await settingsRepository.set(TENANT, "replay.enabled", "false");
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const signed = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSignedUrlRequest(),
    });
    expect(signed.statusCode).toBe(403);
    expect(signed.json().error).toBe("replay_disabled");

    const complete = await app.inject({
      method: "POST",
      url: "/v1/replay/complete",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validManifestRequest(),
    });
    expect(complete.statusCode).toBe(403);
    expect(complete.json().error).toBe("replay_disabled");
    // Nothing persisted.
    expect(
      await replayManifestStore.listBySession(TENANT, VALID_ULID_SESSION)
    ).toHaveLength(0);
  });

  it("allows the upload when replay is enabled (default policy)", async () => {
    const replayManifestStore = new InMemoryReplayManifestStore();
    const { app, storage } = await buildTestApp({ replayManifestStore });
    close = () => app.close();
    storage.putObject(expectedKey, { size: 1024, sha256: VALID_SHA256 });

    const signed = await app.inject({
      method: "POST",
      url: "/v1/replay/signed-url",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: validSignedUrlRequest(),
    });
    expect(signed.statusCode).toBe(201);
  });
});

// The route deny-list is enforced SDK-side (A1) from the tenant settings this
// server exposes; the public replay upload schema carries no route name, so
// the deny-list matcher is unit-tested directly here.
describe("isReplayAllowed (route deny-list matcher)", () => {
  it("denies exact + trailing-glob route matches, allows the rest", () => {
    const policy = {
      enabled: true,
      sampleRate: 1,
      routeDenyList: ["/checkout", "/admin/*"],
    };
    expect(isReplayAllowed(policy, "/checkout").allowed).toBe(false);
    expect(isReplayAllowed(policy, "/checkout").reason).toBe("route_denied");
    expect(isReplayAllowed(policy, "/admin/settings").allowed).toBe(false);
    expect(isReplayAllowed(policy, "/dashboard").allowed).toBe(true);
    expect(isReplayAllowed(policy, undefined).allowed).toBe(true);
  });

  it("denies everything when replay is disabled, regardless of route", () => {
    const policy = { enabled: false, sampleRate: 1, routeDenyList: [] };
    expect(isReplayAllowed(policy, "/dashboard").reason).toBe("replay_disabled");
  });
});
