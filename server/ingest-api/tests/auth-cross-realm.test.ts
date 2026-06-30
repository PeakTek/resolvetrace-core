/**
 * Regression: the auth plugin must map a resolver auth failure to 401 even
 * when the resolver throws error classes from a SEPARATE realm — i.e. a
 * structurally-identical but distinct copy of `TenantResolverError` /
 * `InvalidApiKeyError`.
 *
 * This is the classic dual-package hazard: when `buildApp` is composed with a
 * custom `TenantConfigResolver` whose error classes are loaded from a different
 * copy of these types (a resolver bundled separately from this package), a
 * plain `instanceof` against core's own classes is identity-based and returns
 * false across the copy boundary — so before the fix every invalid / revoked /
 * unknown-tenant key surfaced as a 500 instead of a 401 (only the missing-header
 * case, handled before the resolver runs, returned 401). The public contract
 * requires all of these to be indistinguishable 401s.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { validBatch } from "../test-utils/fixtures.js";
import type {
  ApiKeyPrincipal,
  TenantConfig,
  TenantConfigResolver,
} from "../../tenant-resolver/index.js";
import type { MockResolver } from "../test-utils/mocks.js";

// A foreign-realm copy of core's resolver error hierarchy. Same class NAMES
// (so `constructor.name` matches) but a DISTINCT identity (so `instanceof`
// against core's classes is false) — exactly like a resolver bundled from a
// separate copy of these types.
class TenantResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantResolverError";
  }
}
class InvalidApiKeyError extends TenantResolverError {
  constructor(message = "Invalid API key") {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

const TENANT: TenantConfig = {
  tenantId: "foreign-realm-tenant",
  dbDsn: "postgres://local/test",
  redisEndpoint: "redis://local:6379/0",
  redisKeyPrefix: "",
  s3Bucket: "test-bucket",
  s3KeyPrefix: "",
  kmsAlias: "alias/resolvetrace/test",
  ingestHost: "resolvetrace.local",
};

/** Resolver whose auth path always throws the foreign-realm error. */
const foreignRealmResolver: TenantConfigResolver = {
  async resolveByTenantId(): Promise<TenantConfig> {
    return TENANT;
  },
  async resolveByIngestHost(): Promise<TenantConfig> {
    return TENANT;
  },
  async resolveByApiKey(): Promise<ApiKeyPrincipal> {
    throw new InvalidApiKeyError();
  },
  invalidate(): void {
    /* no-op */
  },
};

describe("auth plugin — cross-realm resolver errors", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("maps a foreign-realm InvalidApiKeyError to 401, not 500", async () => {
    const { app } = await buildTestApp({
      resolver: foreignRealmResolver as unknown as MockResolver,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer rt_local_foreign.realm.key",
        "content-type": "application/json",
      },
      payload: validBatch(),
    });

    expect(res.statusCode).toBe(401);
  });
});
