/**
 * Mock adapters used by the route tests.
 *
 * Deterministic, in-memory, no network. Each mock exposes enough hooks for
 * tests to assert on interactions (how many events enqueued, which keys
 * probed, etc.) without pulling in a mocking library.
 */

import {
  ApiKeyPrincipal,
  Environment,
  InvalidApiKeyError,
  TenantConfig,
  TenantConfigResolver,
} from "../../tenant-resolver/index.js";
import {
  ObjectMetadata,
  ObjectNotFoundError,
  ObjectStorage,
  SignedUploadUrl,
  SignedUploadUrlInput,
} from "../../storage/index.js";
import {
  EventRecord,
  EventRepository,
  SessionRecord,
  SessionRepository,
} from "../types.js";

export interface MockResolverOptions {
  tenantId?: string;
  apiKey?: string;
  /**
   * Optional second accepted bearer token. Mirrors the production
   * `SingleTenantResolver`'s portal-token behaviour so routes guarded by a
   * principal can be exercised from tests with either credential.
   */
  portalApiKey?: string;
  env?: Environment;
}

export class MockResolver implements TenantConfigResolver {
  readonly config: TenantConfig;
  private readonly apiKey: string;
  private readonly portalApiKey: string | undefined;
  private readonly env: Environment;

  constructor(opts: MockResolverOptions = {}) {
    const tenantId = opts.tenantId ?? "oss-test-tenant";
    this.config = {
      tenantId,
      dbDsn: "postgres://local/test",
      redisEndpoint: "redis://local:6379/0",
      redisKeyPrefix: "",
      s3Bucket: "test-bucket",
      s3KeyPrefix: "",
      kmsAlias: "alias/resolvetrace/test",
      ingestHost: "resolvetrace.local",
    };
    this.apiKey = opts.apiKey ?? "test-api-key";
    this.portalApiKey = opts.portalApiKey;
    this.env = opts.env ?? "dev";
  }

  async resolveByTenantId(): Promise<TenantConfig> {
    return this.config;
  }

  async resolveByIngestHost(): Promise<TenantConfig> {
    return this.config;
  }

  async resolveByApiKey(apiKey: string): Promise<ApiKeyPrincipal> {
    const matches =
      apiKey === this.apiKey ||
      (this.portalApiKey !== undefined && apiKey === this.portalApiKey);
    if (!matches) {
      throw new InvalidApiKeyError();
    }
    return {
      config: this.config,
      env: this.env,
      scopes: ["events:write", "replay:write", "session:read"],
      jti: "mock-jti",
    };
  }

  invalidate(): void {
    // no-op
  }
}

/**
 * In-memory `SessionRepository` for tests. Accepts a fixed row set and a
 * pre-computed paginated view; tests assert on the call arguments via
 * `lastList` / `lastGet`.
 */
export class MockSessionRepository implements SessionRepository {
  public lastList: {
    tenantId: string;
    opts: { limit: number; cursor?: string };
  } | undefined;
  public lastGet: { tenantId: string; sessionId: string } | undefined;

  constructor(
    private readonly sessions: SessionRecord[] = [],
    private readonly nextCursor?: string
  ) {}

  async list(
    tenantId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ sessions: SessionRecord[]; nextCursor?: string }> {
    this.lastList = { tenantId, opts };
    return this.nextCursor
      ? { sessions: this.sessions, nextCursor: this.nextCursor }
      : { sessions: this.sessions };
  }

  async get(
    tenantId: string,
    sessionId: string
  ): Promise<SessionRecord | null> {
    this.lastGet = { tenantId, sessionId };
    return (
      this.sessions.find((s) => s.sessionId === sessionId) ?? null
    );
  }
}

/**
 * In-memory `EventRepository` for tests. Returns the injected event list
 * verbatim regardless of session id; tests assert on the captured call via
 * `lastCall`.
 */
export class MockEventRepository implements EventRepository {
  public lastCall: {
    tenantId: string;
    sessionId: string;
    opts: { limit: number; cursor?: string };
  } | undefined;

  constructor(
    private readonly events: EventRecord[] = [],
    private readonly nextCursor?: string
  ) {}

  async listBySession(
    tenantId: string,
    sessionId: string,
    opts: { limit: number; cursor?: string }
  ): Promise<{ events: EventRecord[]; nextCursor?: string }> {
    this.lastCall = { tenantId, sessionId, opts };
    return this.nextCursor
      ? { events: this.events, nextCursor: this.nextCursor }
      : { events: this.events };
  }
}

export interface MockStorageOptions {
  /** If provided, `headObject` returns this metadata for known keys. */
  objects?: Record<string, ObjectMetadata>;
  /** If true, all `headObject` calls return NotFound. */
  allMissing?: boolean;
}

export class MockStorage implements ObjectStorage {
  public readonly signedUrlsMinted: SignedUploadUrlInput[] = [];
  public readonly headCalls: string[] = [];
  public readonly deleted: string[] = [];
  private objects: Map<string, ObjectMetadata>;
  private readonly allMissing: boolean;

  constructor(opts: MockStorageOptions = {}) {
    this.objects = new Map(Object.entries(opts.objects ?? {}));
    this.allMissing = opts.allMissing ?? false;
  }

  async createSignedUploadUrl(
    input: SignedUploadUrlInput
  ): Promise<SignedUploadUrl> {
    this.signedUrlsMinted.push(input);
    return {
      url: `https://mock.storage.local/${input.key}?sig=stub`,
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.maxBytes),
      },
    };
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    this.headCalls.push(key);
    if (this.allMissing) throw new ObjectNotFoundError(key);
    const meta = this.objects.get(key);
    if (!meta) throw new ObjectNotFoundError(key);
    return meta;
  }

  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }

  /** Inject an object the test expects to be present. */
  putObject(key: string, metadata: ObjectMetadata): void {
    this.objects.set(key, metadata);
  }
}
