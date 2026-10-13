import { LRUCache } from "lru-cache";
import type { Cache, CacheSetOptions } from "./Cache.js";

/**
 * `lru-cache`-backed cache used in tests and as a graceful fallback when
 * Redis is unavailable.
 *
 * Tag tracking is in-process only — the `tagIndex` Map mirrors the Redis
 * Sets that `RedisCache` uses. `invalidateTag(tag)` walks the index +
 * deletes the keys + drops the tag set, mirroring Redis behavior.
 *
 * Designed for *single-process* use only. In a multi-instance deployment
 * each instance has its own cache, so tag invalidation in one instance
 * does NOT propagate. This is acceptable for the test-fixture and
 * dev-fallback use cases. Production must use `RedisCache`.
 */

export interface InMemoryCacheOptions {
  /** Max number of entries before LRU eviction. Default 10_000. */
  max?: number;
  /** Default TTL (ms) for entries created without a TTL. */
  defaultTtlMs?: number;
}

// lru-cache's value type is constrained to non-null/undefined objects;
// we wrap arbitrary values in a single-property holder so primitives,
// arrays, and class instances all round-trip cleanly.
interface Box {
  v: unknown;
}

export class InMemoryCache implements Cache {
  private store: LRUCache<string, Box>;
  /** tag → set of cache keys tagged with it. */
  private tagIndex = new Map<string, Set<string>>();

  constructor(opts: InMemoryCacheOptions = {}) {
    this.store = new LRUCache<string, Box>({
      max: opts.max ?? 10_000,
      ttl: opts.defaultTtlMs,
      ttlAutopurge: opts.defaultTtlMs !== undefined,
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const box = this.store.get(key);
    if (box === undefined) return null;
    return box.v as T;
  }

  async setIfAbsent<T = unknown>(
    key: string,
    value: T,
    opts: { ttlSec?: number } = {},
  ): Promise<boolean> {
    if (this.store.has(key)) return false;
    const ttlMs = opts.ttlSec !== undefined ? opts.ttlSec * 1000 : undefined;
    const box: Box = { v: value };
    if (ttlMs !== undefined && ttlMs > 0) {
      this.store.set(key, box, { ttl: ttlMs });
    } else {
      this.store.set(key, box);
    }
    return true;
  }

  async set<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    const ttlMs = opts.ttlSec !== undefined ? opts.ttlSec * 1000 : undefined;
    const box: Box = { v: value };
    if (ttlMs !== undefined && ttlMs > 0) {
      this.store.set(key, box, { ttl: ttlMs });
    } else {
      this.store.set(key, box);
    }
    if (opts.tags) {
      for (const tag of opts.tags) {
        let bucket = this.tagIndex.get(tag);
        if (!bucket) {
          bucket = new Set<string>();
          this.tagIndex.set(tag, bucket);
        }
        bucket.add(key);
      }
    }
  }

  async del(key: string | readonly string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key as string];
    for (const k of keys) {
      this.store.delete(k);
      // Also drop from any tag buckets so invalidateTag doesn't try to
      // delete already-evicted keys.
      for (const bucket of this.tagIndex.values()) {
        bucket.delete(k);
      }
    }
  }

  async invalidateTag(tag: string): Promise<void> {
    const bucket = this.tagIndex.get(tag);
    if (!bucket) return;
    for (const k of bucket) this.store.delete(k);
    this.tagIndex.delete(tag);
  }

  async clear(): Promise<void> {
    this.store.clear();
    this.tagIndex.clear();
  }
}
