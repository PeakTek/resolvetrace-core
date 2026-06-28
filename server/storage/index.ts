/**
 * Storage subsystem public surface.
 */

export * from "./types.js";
export { S3Storage } from "./s3.js";
export type { PresignerFn, S3StorageOptions } from "./s3.js";

import { S3Storage } from "./s3.js";
import { ObjectStorage, StorageConfigError } from "./types.js";

/**
 * Build the default object-storage adapter from env vars. Expects at a
 * minimum `AWS_REGION` and `S3_BUCKET`. `S3_ENDPOINT` selects MinIO (or
 * any S3-compatible server) when present.
 *
 * `S3_PUBLIC_ENDPOINT` (optional) signs **upload** URLs against a
 * browser-reachable host for split-horizon setups (server on a private network
 * where the store is e.g. `http://minio:9000`, browsers outside it). Leave it
 * unset whenever `S3_ENDPOINT` is already browser-reachable (real S3/MinIO).
 *
 * Credentials come from either `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
 * or the default AWS SDK credential chain if those env vars are unset.
 */
export function createStorage(
  env: NodeJS.ProcessEnv = process.env
): ObjectStorage {
  const region = env.AWS_REGION;
  const bucket = env.S3_BUCKET;
  if (!region) throw new StorageConfigError("AWS_REGION is required");
  if (!bucket) throw new StorageConfigError("S3_BUCKET is required");

  const explicitCredentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined;

  return new S3Storage({
    region,
    bucket,
    endpoint: env.S3_ENDPOINT || undefined,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
    credentials: explicitCredentials,
    keyPrefix: env.S3_PREFIX,
  });
}
