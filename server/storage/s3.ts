/**
 * S3 / MinIO object storage adapter.
 *
 * Wraps the AWS SDK v3 S3 client. The same adapter handles both AWS S3 and
 * MinIO: when `S3_ENDPOINT` is set and non-empty the adapter points at
 * MinIO, otherwise it uses the default AWS endpoint resolution. Path-style
 * addressing is enabled for MinIO compatibility.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ObjectMetadata,
  ObjectNotFoundError,
  ObjectStorage,
  SignedDownloadUrl,
  SignedDownloadUrlInput,
  SignedUploadUrl,
  SignedUploadUrlInput,
  StorageConfigError,
} from "./types.js";

/**
 * Signature for the presigner function. The production value is
 * `@aws-sdk/s3-request-presigner`'s `getSignedUrl`; tests can inject a
 * deterministic stub that does not need a real S3Client. Accepts either a
 * PUT (upload) or GET (download) command.
 */
export type PresignerFn = (
  client: S3Client,
  command: PutObjectCommand | GetObjectCommand,
  options: { expiresIn: number }
) => Promise<string>;

export interface S3StorageOptions {
  /**
   * AWS region. For MinIO the value is nominal (MinIO ignores region on
   * request routing) but the SDK requires it for the signer.
   */
  region: string;
  /** Bucket name. */
  bucket: string;
  /** Optional S3-compatible endpoint (e.g. MinIO at `http://minio:9000`). */
  endpoint?: string;
  /**
   * Optional browser-reachable endpoint used ONLY to sign **upload** URLs.
   *
   * A presigned URL's host is bound into its SigV4 signature, so the client
   * that PUTs the chunk must reach the same host the server signed against.
   * In a real deployment `endpoint` is already public, so this is unset and
   * uploads sign against it. But in a split-horizon topology — server inside a
   * private network (e.g. MinIO at `http://minio:9000`), browser outside it —
   * the internal host is unreachable from the browser. Setting this to a
   * browser-reachable endpoint (e.g. `http://localhost:9000`) makes upload
   * URLs target a host the browser can actually PUT to, while the server's own
   * operations (head/delete) and **download** presigning keep using `endpoint`
   * (download URLs are consumed server-side by the portal read-proxy, in-net).
   */
  publicEndpoint?: string;
  /** Optional forced credentials. Falls back to the default credential chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Optional global key prefix joined to every `key` parameter. */
  keyPrefix?: string;
  /**
   * Test seam: inject an S3Client so unit tests do not construct a real
   * AWS client. Production code leaves this unset.
   */
  client?: S3Client;
  /**
   * Test seam: inject the client used to sign **upload** URLs (the
   * `publicEndpoint` client). Production code leaves this unset; it is built
   * from `publicEndpoint` (or falls back to the main client).
   */
  uploadClient?: S3Client;
  /**
   * Test seam: inject a presigner function. Defaults to the real SDK
   * `getSignedUrl`. Tests supply a stub that does not require the SDK's
   * signer middleware to be wired up.
   */
  presigner?: PresignerFn;
}

export class S3Storage implements ObjectStorage {
  readonly bucket: string;
  readonly keyPrefix: string;
  private readonly client: S3Client;
  /** Client used to sign UPLOAD URLs — same as `client` unless `publicEndpoint`. */
  private readonly uploadClient: S3Client;
  private readonly presigner: PresignerFn;

  constructor(opts: S3StorageOptions) {
    if (!opts.region) throw new StorageConfigError("S3 region is required");
    if (!opts.bucket) throw new StorageConfigError("S3 bucket is required");
    this.bucket = opts.bucket;
    this.keyPrefix = normalizePrefix(opts.keyPrefix);
    this.presigner = opts.presigner ?? getSignedUrl;

    const buildClient = (endpoint?: string): S3Client => {
      const cfg: S3ClientConfig = {
        region: opts.region,
        // MinIO is compatible with path-style addressing; virtual-host-style
        // requires DNS wildcards the local stack doesn't have.
        forcePathStyle: Boolean(endpoint),
      };
      if (endpoint) cfg.endpoint = endpoint;
      if (opts.credentials) cfg.credentials = opts.credentials;
      return new S3Client(cfg);
    };

    this.client = opts.client ?? buildClient(opts.endpoint);
    // Upload URLs sign against the browser-reachable endpoint when configured;
    // otherwise they sign against the same client as everything else.
    this.uploadClient =
      opts.uploadClient ??
      (opts.publicEndpoint ? buildClient(opts.publicEndpoint) : this.client);
  }

  async createSignedUploadUrl(
    input: SignedUploadUrlInput
  ): Promise<SignedUploadUrl> {
    if (input.maxBytes <= 0) {
      throw new StorageConfigError("maxBytes must be positive");
    }
    if (input.expiresInSeconds <= 0) {
      throw new StorageConfigError("expiresInSeconds must be positive");
    }

    const key = this.qualify(input.key);
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: input.contentType,
      // ContentLength pins the exact body size. The client is expected to
      // replay this header value.
      ContentLength: input.maxBytes,
    });
    // Sign UPLOAD URLs against the browser-reachable client (see publicEndpoint).
    const url = await this.presigner(this.uploadClient, cmd, {
      expiresIn: input.expiresInSeconds,
    });
    return {
      url,
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.maxBytes),
      },
    };
  }

  async createSignedDownloadUrl(
    input: SignedDownloadUrlInput
  ): Promise<SignedDownloadUrl> {
    if (input.expiresInSeconds <= 0) {
      throw new StorageConfigError("expiresInSeconds must be positive");
    }
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.qualify(input.key),
    });
    const url = await this.presigner(this.client, cmd, {
      expiresIn: input.expiresInSeconds,
    });
    return {
      url,
      expiresAt: new Date(
        Date.now() + input.expiresInSeconds * 1000
      ).toISOString(),
    };
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.qualify(key) })
      );
      // Some backends expose a SHA-256 via ChecksumSHA256; fall through to
      // null when not present.
      return {
        size: typeof out.ContentLength === "number" ? out.ContentLength : 0,
        sha256: out.ChecksumSHA256 ?? null,
      };
    } catch (err: unknown) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.qualify(key) })
    );
  }

  private qualify(key: string): string {
    if (!key) throw new StorageConfigError("key must be non-empty");
    return `${this.keyPrefix}${key}`;
  }
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}
