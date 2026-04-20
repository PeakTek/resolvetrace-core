/**
 * Tenant resolver public surface.
 *
 * Consumers import from this module; deeper imports are not supported and
 * may be refactored without warning.
 */

export * from "./types.js";
export { SingleTenantResolver } from "./single-tenant.js";
export type { SingleTenantResolverOptions } from "./single-tenant.js";

import { SingleTenantResolver } from "./single-tenant.js";
import { Environment, TenantConfigResolver } from "./types.js";

/**
 * Build the default resolver from environment variables. This is the
 * factory the OSS server boots with; non-default deployments can construct
 * a `SingleTenantResolver` directly.
 *
 * Required env:
 * - `DATABASE_URL`
 * - `REDIS_URL`
 * - `S3_BUCKET`
 * - `OSS_API_KEY`
 *
 * Optional env:
 * - `RESOLVETRACE_TENANT_ID` (default: `oss-single-tenant`)
 * - `INGEST_HOST` (default: `resolvetrace.local`)
 * - `KMS_ALIAS`, `S3_PREFIX`, `REDIS_PREFIX`
 * - `RESOLVETRACE_ENV` (`prod` | `staging` | `dev`; default `prod`)
 */
export function createResolver(
  env: NodeJS.ProcessEnv = process.env
): TenantConfigResolver {
  const tenantId = env.RESOLVETRACE_TENANT_ID ?? "oss-single-tenant";
  const dbDsn = requireEnv(env, "DATABASE_URL");
  const redisEndpoint = requireEnv(env, "REDIS_URL");
  const s3Bucket = requireEnv(env, "S3_BUCKET");
  const apiKey = requireEnv(env, "OSS_API_KEY");
  const envTag = parseEnvTag(env.RESOLVETRACE_ENV);

  return new SingleTenantResolver({
    tenantId,
    dbDsn,
    redisEndpoint,
    redisKeyPrefix: env.REDIS_PREFIX,
    s3Bucket,
    s3KeyPrefix: env.S3_PREFIX,
    kmsAlias: env.KMS_ALIAS,
    ingestHost: env.INGEST_HOST,
    apiKey,
    env: envTag,
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseEnvTag(value: string | undefined): Environment {
  switch (value) {
    case "prod":
    case "staging":
    case "dev":
      return value;
    case undefined:
    case "":
      return "prod";
    default:
      throw new Error(
        `RESOLVETRACE_ENV must be one of 'prod' | 'staging' | 'dev'; got '${value}'`
      );
  }
}
