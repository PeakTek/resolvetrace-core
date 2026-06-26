/**
 * Object storage abstraction.
 *
 * Replay chunks and other binary artifacts go to object storage. The OSS
 * server ships an adapter that speaks the S3 API, which covers both AWS S3
 * and MinIO (the S3-compatible OSS substitute used in the local Docker
 * Compose quickstart). Service code never talks to `@aws-sdk` directly;
 * it always goes through this interface.
 */

/** Inputs for minting a signed upload URL. */
export interface SignedUploadUrlInput {
  /** Object key (prefix-joined by the adapter from the tenant's key prefix). */
  key: string;
  /** Allowed Content-Type header; the adapter pins this in the signed URL. */
  contentType: string;
  /** Hard upper bound on the uploaded body size in bytes. */
  maxBytes: number;
  /** URL lifetime, in seconds. */
  expiresInSeconds: number;
}

/** Result of minting a signed upload URL. */
export interface SignedUploadUrl {
  url: string;
  /** Required headers the client must replay. */
  headers: Record<string, string>;
}

/** Inputs for minting a signed, time-boxed download (GET) URL. */
export interface SignedDownloadUrlInput {
  /** Object key (prefix-joined by the adapter from the tenant's key prefix). */
  key: string;
  /** URL lifetime, in seconds. */
  expiresInSeconds: number;
}

/** Result of minting a signed download URL. */
export interface SignedDownloadUrl {
  url: string;
  /** Absolute expiry, ISO 8601 — convenience for callers/audit. */
  expiresAt: string;
}

/** Metadata for a stored object. */
export interface ObjectMetadata {
  size: number;
  /** SHA-256 of the object body if the backend reports one; null otherwise. */
  sha256: string | null;
}

/** The object-storage interface every adapter implements. */
export interface ObjectStorage {
  createSignedUploadUrl(
    input: SignedUploadUrlInput
  ): Promise<SignedUploadUrl>;
  /**
   * Mint a short-lived, signed GET URL for an existing object. Used by the
   * portal read-side so the player can fetch a replay chunk directly from
   * storage without the chunk bytes flowing through the API. The caller is
   * responsible for authorization + auditing before minting.
   */
  createSignedDownloadUrl(
    input: SignedDownloadUrlInput
  ): Promise<SignedDownloadUrl>;
  headObject(key: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
}

/** Raised when a requested object does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

/** Raised when storage configuration is missing or malformed. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}
