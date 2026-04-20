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
