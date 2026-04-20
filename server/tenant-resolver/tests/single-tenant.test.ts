import { describe, expect, it } from "vitest";
import {
  InvalidApiKeyError,
  SingleTenantResolver,
} from "../index.js";

function makeResolver(overrides: Partial<Parameters<typeof SingleTenantResolver.prototype.constructor>[0]> = {}) {
  return new SingleTenantResolver({
    tenantId: "test-tenant",
    dbDsn: "postgres://u:p@localhost:5432/db",
    redisEndpoint: "redis://localhost:6379/0",
    s3Bucket: "test-bucket",
    apiKey: "test-api-key-long-enough",
    ...overrides,
  });
}

describe("SingleTenantResolver", () => {
  it("resolveByTenantId returns the configured tenant shape", async () => {
    const r = makeResolver();
    const cfg = await r.resolveByTenantId("anything");
    expect(cfg.tenantId).toBe("test-tenant");
    expect(cfg.dbDsn).toBe("postgres://u:p@localhost:5432/db");
    expect(cfg.redisEndpoint).toBe("redis://localhost:6379/0");
    expect(cfg.s3Bucket).toBe("test-bucket");
    expect(cfg.ingestHost).toBe("resolvetrace.local");
    expect(cfg.s3KeyPrefix).toBe("");
    expect(cfg.redisKeyPrefix).toBe("");
    expect(cfg.kmsAlias).toMatch(/^alias\//);
  });

  it("resolveByIngestHost returns the same config regardless of host", async () => {
    const r = makeResolver();
    const a = await r.resolveByIngestHost("alpha.example.com");
    const b = await r.resolveByIngestHost("bravo.example.com");
    expect(a).toEqual(b);
  });

  it("resolveByApiKey returns a principal for the matching key", async () => {
    const r = makeResolver();
    const p = await r.resolveByApiKey("test-api-key-long-enough");
    expect(p.config.tenantId).toBe("test-tenant");
    expect(p.env).toBe("prod");
    expect(Array.isArray(p.scopes)).toBe(true);
    expect(p.scopes.length).toBeGreaterThan(0);
    expect(p.jti).toBeDefined();
  });

  it("resolveByApiKey rejects a wrong key with InvalidApiKeyError", async () => {
    const r = makeResolver();
    await expect(r.resolveByApiKey("wrong-key")).rejects.toBeInstanceOf(
      InvalidApiKeyError
    );
  });

  it("resolveByApiKey rejects an empty key", async () => {
    const r = makeResolver();
    await expect(r.resolveByApiKey("")).rejects.toBeInstanceOf(
      InvalidApiKeyError
    );
  });

  it("rejects keys whose length differs (does not short-circuit timing)", async () => {
    const r = makeResolver({ apiKey: "short" });
    // Presenting a longer candidate must still reject.
    await expect(r.resolveByApiKey("short-but-longer")).rejects.toBeInstanceOf(
      InvalidApiKeyError
    );
  });

  it("invalidate is a no-op (does not throw)", () => {
    const r = makeResolver();
    expect(() => r.invalidate("anything")).not.toThrow();
  });

  it("respects overridden ingest host and key prefixes", async () => {
    const r = makeResolver({
      ingestHost: "custom.example",
      redisKeyPrefix: "rt:",
      s3KeyPrefix: "replay/",
      kmsAlias: "alias/custom",
      env: "dev",
    });
    const cfg = await r.resolveByTenantId("anything");
    expect(cfg.ingestHost).toBe("custom.example");
    expect(cfg.redisKeyPrefix).toBe("rt:");
    expect(cfg.s3KeyPrefix).toBe("replay/");
    expect(cfg.kmsAlias).toBe("alias/custom");
    const p = await r.resolveByApiKey("test-api-key-long-enough");
    expect(p.env).toBe("dev");
  });
});
