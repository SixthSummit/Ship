import type { Cache, CacheSetOptions } from "./Cache.js";

/**
 * `cached(cache, key, ttlSec, fn, opts?)` — read-through cache helper.
 *
 * On cache hit, returns the stored value. On miss, runs `fn()`, stores the
 * result with the supplied TTL + tags, and returns it.
 *
 * No promise coalescing — if N concurrent callers miss for the same key
 * they all run `fn()` and the last write wins. Acceptable for idempotent
 * read-through caching of expensive lookups; not safe for non-idempotent
 * `fn()` (use a queue or distributed lock for those).
 *
 * `fn()` returning `undefined` skips the store step (treated as "do not
 * cache"). `null` IS cached — it represents a known absence.
 *
 * @example
 * const account = await cached(cache, `accounts:${id}`, 60, () =>
 *   accountService.getById(id),
 * );
 *
 * @example
 * const profile = await cached(
 *   cache, `profiles:${userId}`, 300,
 *   () => profileService.fetch(userId),
 *   { tags: [`user:${userId}`] },
 * );
 * // Later: cache.invalidateTag(`user:${userId}`) wipes everything tagged.
 */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlSec: number,
  fn: () => Promise<T> | T,
  opts: Omit<CacheSetOptions, "ttlSec"> = {},
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null) return hit;

  const value = await fn();
  if (value !== undefined) {
    await cache.set(key, value, { ttlSec, tags: opts.tags });
  }
  return value;
}
