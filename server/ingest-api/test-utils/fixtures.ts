/**
 * Tiny payload fixtures for the route tests. Kept minimal — deep schema
 * conformance is enforced by the contract repo's conformance harness.
 */

export const VALID_ULID_A = "01HWZX9KT1N2M3J4P5Q6R7S8AB";
export const VALID_ULID_B = "01HWZX9KT1N2M3J4P5Q6R7S8AC";
export const VALID_ULID_SESSION = "01HXA0C4YFGJXQZ2P3R4T5V6WD";

export const VALID_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: VALID_ULID_A,
    type: "page_view",
    capturedAt: "2026-04-20T12:34:56.789Z",
    scrubber: {
      version: "sdk@0.1.0",
      rulesDigest: `sha256:${VALID_SHA256}`,
      applied: ["regex:email"],
      budgetExceeded: false,
    },
    sdk: {
      name: "@peaktek/resolvetrace-sdk",
      version: "0.1.0",
    },
    ...overrides,
  };
}

export function validBatch(events = [validEvent()]) {
  return { events };
}

export function validSignedUrlRequest(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: VALID_ULID_SESSION,
    sequence: 0,
    approxBytes: 1024,
    contentType: "application/vnd.resolvetrace.replay+rrweb",
    ...overrides,
  };
}

export function validManifestRequest(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: VALID_ULID_SESSION,
    sequence: 0,
    key: `oss-test-tenant/${VALID_ULID_SESSION}/0.rrweb`,
    bytes: 1024,
    sha256: VALID_SHA256,
    clientUploadedAt: "2026-04-20T12:35:00.000Z",
    scrubber: {
      version: "sdk@0.1.0",
      rulesDigest: `sha256:${VALID_SHA256}`,
      applied: [],
      budgetExceeded: false,
    },
    ...overrides,
  };
}

export function validSessionStart(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: VALID_ULID_SESSION,
    startedAt: "2026-04-20T12:30:00.000Z",
    appVersion: "1.0.0",
    ...overrides,
  };
}

export function validSessionEnd(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: VALID_ULID_SESSION,
    endedAt: "2026-04-20T12:40:00.000Z",
    reason: "closed",
    ...overrides,
  };
}

export const AUTH_HEADER = "Bearer test-api-key";
