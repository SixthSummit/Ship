/**
 * Framework-wide `Cache` interface.
 *
 * Two reference implementations ship in v4.0:
 *   - `RedisCache` — production default, msgpackr-serialized, with
 *     tag-based invalidation via Redis Sets.
 *   - `InMemoryCache` — `lru-cache`-backed; intended for tests + dev
 *     fallback when Redis is unavailable.
 *
 * Consumers usually don't construct caches directly — `cached(key, ttl, fn)`
 * is the high-level helper that hides the lookup / miss / store dance.
 *
 * The interface is intentionally narrow: any backend that can do `get`,
 * `set` (with TTL), `del`, and tag-tracking can plug in. Future v4.x
 * adapters (Memcached, Cloudflare KV, Upstash) implement the same contract.
 */

export interface CacheSetOptions {
  /** TTL in seconds. `undefined` means no expiry (use sparingly). */
  ttlSec?: number;
  /**
   * Tag this key under each label. `invalidateTag(tag)` later wipes all keys
   * sharing the tag — useful for "everything related to user X" or
   * "everything in module Y".
   */
  tags?: readonly string[];
}

export interface Cache {
  /** Returns `null` on miss. */
  get<T = unknown>(key: string): Promise<T | null>;

  /** Store with optional TTL + tags. Idempotent. */
  set<T = unknown>(key: string, value: T, opts?: CacheSetOptions): Promise<void>;

  /**
   * Atomic SET-IF-ABSENT. Stores `value` if no entry already exists at `key`,
   * returning `true`; returns `false` when an entry is present (no-op).
   *
   * Used as a low-level claim / lock primitive — the idempotency middleware
   * uses it to deduplicate concurrent requests sharing an `Idempotency-Key`.
   * Tags are NOT supported here (locks should not survive `invalidateTag`).
   *
   * Redis: implemented via `SET NX EX` (atomic at the Redis server).
   * In-memory: the `has` / `set` body runs synchronously inside the async
   * function — within a single event-loop tick the check + write is a true
   * CAS.
   *
   * **F19 — Atomicity invariant.** Implementations MUST run the check + write
   * in one continuation (no `await` between them). A future refactor that
   * inserts an `await` silently breaks idempotency under concurrent load on
   * a public app — multiple callers would see an empty slot, all "claim" the
   * key, and the cache ends up holding the last writer's value with every
   * caller observing `true`. The regression test in
   * `InMemoryCache.test.ts` (100 concurrent `setIfAbsent("same-key")` →
   * exactly one `true`) is the canary that catches the regression.
   */
  setIfAbsent<T = unknown>(key: string, value: T, opts?: { ttlSec?: number }): Promise<boolean>;

  /** Delete one or many keys. Missing keys are silently ignored. */
  del(key: string | readonly string[]): Promise<void>;

  /**
   * Wipe every key recorded under `tag`, plus the tag-tracking record itself.
   * Use for "user updated → invalidate everything tagged `user:<id>`".
   */
  invalidateTag(tag: string): Promise<void>;

  /**
   * Optional admin / test hook. Implementations that can't cheaply enumerate
   * may throw. Avoid in production paths.
   */
  clear?(): Promise<void>;
}
