/**
 * Tenant resolver types.
 *
 * Every runtime service in the OSS server reads its data-plane resources
 * (Postgres DSN, Redis endpoint, S3 bucket, KMS alias, ingest hostname)
 * through a single resolver indirection. No service is allowed to reference
 * a literal DSN / bucket / Redis URL / KMS key directly; they come from here.
 *
 * In OSS this resolves to one configured tenant; the same interface is
 * preserved so that a self-hoster migrating elsewhere can swap the
 * implementation without touching service code.
 */

/** Deployment environment tag attached to every accepted API key. */
export type Environment = "prod" | "staging" | "dev";

/**
 * Fully-resolved config for a tenant. All data-plane resource coordinates
 * that a service might need are available on this object.
 */
export interface TenantConfig {
  tenantId: string;
  dbDsn: string;
  redisEndpoint: string;
  redisKeyPrefix: string;
  s3Bucket: string;
  s3KeyPrefix: string;
  kmsAlias: string;
  ingestHost: string;
}

/**
 * An authenticated principal derived from a presented API key. Callers
 * receive this wrapper rather than the raw token; the token is never
 * exposed past the resolver boundary.
 */
export interface ApiKeyPrincipal {
  config: TenantConfig;
  env: Environment;
  scopes: string[];
  /** Unique identifier for the presented key; used for log correlation. */
  jti: string;
}

/**
 * Errors thrown by resolver implementations. Services map these to HTTP
 * responses in a single exhaustive switch.
 */
export class TenantResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantResolverError";
  }
}

export class TenantNotFoundError extends TenantResolverError {
  constructor(message = "Tenant not found") {
    super(message);
    this.name = "TenantNotFoundError";
  }
}

export class InvalidApiKeyError extends TenantResolverError {
  constructor(message = "Invalid API key") {
    super(message);
    this.name = "InvalidApiKeyError";
  }
}

/**
 * The core resolver interface. Every service in the OSS server depends on
 * this shape; alternate implementations (e.g. a registry-backed one for
 * non-OSS deployments) are expected to satisfy it byte-for-byte.
 */
export interface TenantConfigResolver {
  /** Primary lookup used by request handlers once the tenant id is known. */
  resolveByTenantId(id: string): Promise<TenantConfig>;

  /**
   * Auth-time lookup. Accepts the raw API key string, verifies it, and
   * returns a principal wrapper. Implementations MUST NOT expose the
   * decoded token to callers.
   */
  resolveByApiKey(apiKey: string): Promise<ApiKeyPrincipal>;

  /**
   * Hostname-based routing lookup. Reserved for deployments that route by
   * ingest host; in OSS single-tenant mode this always returns the fixed
   * config regardless of host.
   */
  resolveByIngestHost(host: string): Promise<TenantConfig>;

  /** Evict a cached tenant config entry. */
  invalidate(id: string): void;
}
