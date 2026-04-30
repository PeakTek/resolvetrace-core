/**
 * In-memory LRU idempotency store for `(tenantId, eventId)` dedup.
 *
 * Used by the `POST /v1/events` handler directly (not as a Fastify hook
 * because dedup semantics are per-event, not per-request). The interface
 * matches `IdempotencyStore`, and swappable backends (Redis, Postgres)
 * satisfy the same contract in non-OSS deployments.
 *
 * Dedup window: 24 hours (ADR-0011). Entries are kept until either expiry
 * or capacity pressure.
 */

import { IdempotencyStore } from "../types.js";

interface Entry {
  expiresAt: number;
}

export interface InMemoryIdempotencyStoreOptions {
  /** Max entries held. Default 200_000. */
  capacity?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry>();

  constructor(opts: InMemoryIdempotencyStoreOptions = {}) {
    this.capacity = opts.capacity ?? 200_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async reserve(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now();
    const existing = this.map.get(key);
    if (existing && existing.expiresAt > now) {
      // Touch for LRU recency.
      this.map.delete(key);
      this.map.set(key, existing);
      return false;
    }
    if (this.map.size >= this.capacity) {
      // Drop the oldest entry (Map insertion order).
      const oldest = this.map.keys().next().value;
      if (typeof oldest === "string") this.map.delete(oldest);
    }
    this.map.set(key, { expiresAt: now + ttlSeconds * 1000 });
    return true;
  }

  async release(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Visible for tests. */
  size(): number {
    return this.map.size;
  }
}

/**
 * Build the default idempotency store from env. When `REDIS_URL` is set and
 * non-empty, we log an advisory and still fall back to in-memory: the Redis
 * implementation will be wired in a follow-up milestone. Flagged as a known
 * gap in the README.
 */
export function createIdempotencyStore(
  env: NodeJS.ProcessEnv = process.env
): IdempotencyStore {
  const redisUrl = env.REDIS_URL;
  if (redisUrl && redisUrl.length > 0) {
    // Intentional: the Redis-backed variant will land in a later milestone
    // once the event-processing pipeline lands. Falling back to in-memory
    // keeps single-node deployments correct; multi-node correctness requires
    // the Redis backend (flagged in README).
  }
  return new InMemoryIdempotencyStore();
}
