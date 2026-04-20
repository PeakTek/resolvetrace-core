/**
 * AWS Systems Manager Parameter Store backed secrets provider.
 *
 * Reads parameters with `WithDecryption: true` so `SecureString` values
 * are returned in cleartext to the caller. Values are cached in memory
 * with a short TTL (default 60s) to avoid a hot-path API call per request.
 *
 * The ParameterStore client is injected so tests can mock it without
 * touching the network.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  SecretDecodeError,
  SecretNotFoundError,
  SecretsProvider,
} from "./types.js";

/** Minimal interface over the AWS SDK SSM client. */
export interface SsmClientLike {
  send(cmd: GetParameterCommand): Promise<{
    Parameter?: { Value?: string };
  }>;
}

export interface ParameterStoreOptions {
  /** Optional injected client. Production code omits this. */
  client?: SsmClientLike;
  /** AWS region (required when no client is injected). */
  region?: string;
  /**
   * Parameter-name prefix prepended to every requested name.
   * E.g. prefix `/resolvetrace/prod/` + name `DB_PASSWORD`
   * resolves to `/resolvetrace/prod/DB_PASSWORD`.
   */
  prefix?: string;
  /** Cache TTL in milliseconds. Defaults to 60_000 (60 s). */
  cacheTtlMs?: number;
  /** Test seam: clock source. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class ParameterStoreSecretsProvider implements SecretsProvider {
  private readonly client: SsmClientLike;
  private readonly prefix: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: ParameterStoreOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.region) {
        throw new Error(
          "ParameterStoreSecretsProvider requires `region` when no client is injected"
        );
      }
      this.client = new SSMClient({ region: opts.region });
    }
    this.prefix = opts.prefix ?? "";
    this.ttlMs = opts.cacheTtlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async get(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const ssmName = `${this.prefix}${name}`;
    const out = await this.client.send(
      new GetParameterCommand({ Name: ssmName, WithDecryption: true })
    );
    const value = out.Parameter?.Value;
    if (value === undefined) {
      throw new SecretNotFoundError(name);
    }
    this.cache.set(name, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
    return value;
  }

  async getJson<T = unknown>(name: string): Promise<T> {
    const raw = await this.get(name);
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new SecretDecodeError(name, err);
    }
  }

  /** Clear the cache (exposed for operator-visible invalidation). */
  invalidateAll(): void {
    this.cache.clear();
  }
}
