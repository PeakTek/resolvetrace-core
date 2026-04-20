/**
 * Single-tenant resolver for the OSS server.
 *
 * One logical tenant. All three `resolveBy*` methods return the same
 * `TenantConfig`. API-key authentication is a simple constant-time
 * comparison against the configured `OSS_API_KEY` value.
 */

import { timingSafeEqual } from "node:crypto";
import {
  ApiKeyPrincipal,
  Environment,
  InvalidApiKeyError,
  TenantConfig,
  TenantConfigResolver,
} from "./types.js";

/** Defaults for fields the operator has not overridden. */
const DEFAULT_TENANT_ID = "oss-single-tenant";
const DEFAULT_INGEST_HOST = "resolvetrace.local";
const DEFAULT_KMS_ALIAS = "alias/resolvetrace/oss/local";
const DEFAULT_JTI = "oss-static-key";
const DEFAULT_SCOPES: readonly string[] = [
  "events:write",
  "replay:write",
  "session:read",
];

export interface SingleTenantResolverOptions {
  tenantId: string;
  dbDsn: string;
  redisEndpoint: string;
  s3Bucket: string;
  /** Optional Redis key prefix; defaults to empty (no prefix). */
  redisKeyPrefix?: string;
  /** Optional S3 key prefix; defaults to empty (no prefix). */
  s3KeyPrefix?: string;
  /** Optional KMS alias; defaults to a local no-op alias name. */
  kmsAlias?: string;
  /** Optional ingest host; defaults to `resolvetrace.local`. */
  ingestHost?: string;
  /**
   * Opaque API key for ingest. Equality-checked with constant-time
   * comparison; rejected if the presented key differs.
   */
  apiKey: string;
  /** Environment stamp returned on principal wrappers. */
  env?: Environment;
  /** Scopes granted to the API-key principal. */
  scopes?: string[];
}

export class SingleTenantResolver implements TenantConfigResolver {
  private readonly config: TenantConfig;
  private readonly apiKey: string;
  private readonly env: Environment;
  private readonly scopes: string[];

  constructor(opts: SingleTenantResolverOptions) {
    this.config = {
      tenantId: opts.tenantId,
      dbDsn: opts.dbDsn,
      redisEndpoint: opts.redisEndpoint,
      redisKeyPrefix: opts.redisKeyPrefix ?? "",
      s3Bucket: opts.s3Bucket,
      s3KeyPrefix: opts.s3KeyPrefix ?? "",
      kmsAlias: opts.kmsAlias ?? DEFAULT_KMS_ALIAS,
      ingestHost: opts.ingestHost ?? DEFAULT_INGEST_HOST,
    };
    this.apiKey = opts.apiKey;
    this.env = opts.env ?? "prod";
    this.scopes = opts.scopes ?? [...DEFAULT_SCOPES];
  }

  async resolveByTenantId(_id: string): Promise<TenantConfig> {
    // OSS has one tenant. We do not reject unknown ids because unknown ids
    // cannot occur on the ingest path (there is no tenant claim to mismatch
    // against). A future registry-backed implementation would do so here.
    return this.config;
  }

  async resolveByApiKey(apiKey: string): Promise<ApiKeyPrincipal> {
    if (!safeEqual(apiKey, this.apiKey)) {
      throw new InvalidApiKeyError();
    }
    return {
      config: this.config,
      env: this.env,
      scopes: [...this.scopes],
      jti: DEFAULT_JTI,
    };
  }

  async resolveByIngestHost(_host: string): Promise<TenantConfig> {
    // OSS accepts any host and serves the single configured tenant.
    return this.config;
  }

  invalidate(_id: string): void {
    // No cache in single-tenant mode; this is a no-op.
  }
}

/**
 * Constant-time string comparison. Returns false on length mismatch without
 * leaking the expected length via early return timing.
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // Pad the shorter buffer so timingSafeEqual never throws, then length-gate.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}
