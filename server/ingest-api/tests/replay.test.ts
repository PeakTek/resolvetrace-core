import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
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
});
