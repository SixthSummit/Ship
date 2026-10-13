# Caching

> **Compatibility feature:** this implementation remains available from the
> monolithic v4 package. Cache behavior is not yet a focused operation-kernel
> capability and must not be treated as a new-application default.

The `Cache` interface, the Redis-backed implementation, the in-memory fallback for tests, the `cached()` helper for the cache-aside pattern, and tag-based invalidation. Plus the operational realities of running a cache layer at scale.

## The interface

```ts
export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: CacheSetOptions): Promise<void>;
  setIfAbsent<T = unknown>(key: string, value: T, opts?: { ttlSec?: number }): Promise<boolean>;
  del(key: string | readonly string[]): Promise<void>;
  invalidateTag(tag: string): Promise<void>;
  clear?(): Promise<void>;            // optional — backends that don't support enumeration omit this
}

export interface CacheSetOptions {
  ttlSec?: number;                    // undefined = no expiry
  tags?: readonly string[];           // tag membership for bulk invalidation
}
```

Two implementations ship:

- **`RedisCache`** — production. Backed by `RedisLike` (any client matching the small interface — node-redis, ioredis, mock).
- **`InMemoryCache`** — tests, single-process fallback. Backed by a `Map`.

Both satisfy the interface; consumers code against the interface, not the implementation.

## A minimal example

```ts
import { RedisCache } from "@sixthsummit/ship-api/app/services/cache/RedisCache";

const cache = new RedisCache({
  client: redisProvider.getClient(),
  keyPrefix: `${env.SERVICE_NAME}:${pkg.version}:`,
});

await cache.set("user:123", { id: "123", name: "Ada" }, { ttlSec: 300, tags: ["user:123"] });

const cached = await cache.get<{ id: string; name: string }>("user:123");
if (cached) return cached;

const fresh = await db.users.findById("123");
await cache.set("user:123", fresh, { ttlSec: 300, tags: ["user:123"] });
return fresh;
```

This is the cache-aside pattern by hand. The framework ships a helper that does the same thing in one call:

```ts
import { cached } from "@sixthsummit/ship-api/app/services/cache/cached";

const user = await cached(
  cache,
  "user:123",
  300,                                // TTL in seconds
  () => db.users.findById("123"),
  { tags: ["user:123"] },
);
```

`cached(cache, key, ttlSec, fn, opts?)` checks the cache, falls back to `fn()` on miss, stores the result, and returns the value. Two operational details:

- **No promise coalescing.** N concurrent cache misses on the same key all run `fn()`. Acceptable for idempotent reads (the cost is N extra DB queries during a brief race window). For non-idempotent operations, use a queue or a distributed lock instead — the cache is for read-through, not write-coordination.
- **`undefined` skips storage.** If `fn()` returns `undefined`, the helper treats that as "do not cache" and the next call will run `fn()` again. Useful when you want negative caching on `null` but not on `undefined`.

## Why a `keyPrefix` matters

The `keyPrefix` option on `RedisCache` namespaces every key. Without it, two services sharing a Redis instance can collide on key names.

The convention is `${SERVICE_NAME}:${VERSION}:` — the version makes deploys safer. After a deploy that changes a cached value's shape, the new version reads/writes under a new prefix, leaving old values stranded (Redis cleans them up at TTL expiry). The alternative — sharing keys across versions — risks deserializing v1-shaped data with v2 code.

## Serialization: msgpackr, not JSON

`RedisCache` uses [msgpackr](https://github.com/kriszyp/msgpackr) for serialization. Two reasons:

- **Smaller payloads.** Binary encoding compresses better than JSON.
- **Type fidelity.** JSON loses `Date`, `Map`, `Set`, `undefined`, and `BigInt`. msgpackr preserves them.

This means cache values can hold richer structures — a `Date` written in roundtrips back as a `Date`, not a string. For interop with non-ShipAPI services reading the same Redis, that's a tradeoff to know about. If interop matters, set values to JSON-serializable shapes and pick a JSON-based cache; the framework's choice is for fidelity.

## Tag-based invalidation

```ts
await cache.set("user:123", value, { tags: ["user:123", "tenant:abc"] });
await cache.set("user:123:profile", profile, { tags: ["user:123"] });
await cache.set("posts:by-user:123", posts, { tags: ["user:123", "posts"] });

// Later, invalidate all keys tagged with user:123:
await cache.invalidateTag("user:123");
// Both user:123 and user:123:profile and posts:by-user:123 are deleted.
```

How it works under the hood:

```
SET cache:user:123 <value>
SADD tag:user:123 cache:user:123          (track key in tag's set)
PEXPIRE tag:user:123 <ttlMs>              (tag set inherits the value's TTL)
```

`invalidateTag("user:123")`:

```
SMEMBERS tag:user:123                     (look up keys)
DEL <those keys>
DEL tag:user:123
```

The cost is **O(N)** in the number of keys under the tag. If a tag has 10,000 members, you're paying for 10,000 deletes. That's fine for most cases; it's catastrophic if you tag every `post:${postId}` under `posts` (now an unrelated invalidation deletes a million keys).

The pattern that works:

- **Tag by logical ownership** — `user:${userId}`, `tenant:${tenantId}`, `org:${orgId}`. Bounded membership.
- **Don't tag by category** — `posts`, `users`, `accounts`. Unbounded membership at scale.

Per-key explicit deletes (`cache.del("user:123:profile")`) are O(1) and don't require tags. Use them for narrow invalidations; reserve tags for "this user's data is stale, kill it all."

## `setIfAbsent` — atomic claim

```ts
const claimed = await cache.setIfAbsent("lock:job:42", "owner-id", { ttlSec: 60 });
if (claimed) {
  // I'm the only worker holding this lock for 60 seconds
} else {
  // Someone else claimed it
}
```

`setIfAbsent` uses Redis `SET NX EX` — atomic compare-and-set. The framework's [idempotency middleware](idempotency.md) uses this to claim a slot before processing a request. Tags aren't supported on `setIfAbsent` (you don't want a lock to evaporate because someone invalidated a tag).

For cooperative locking, use `setIfAbsent`. For exclusive locking with renewable leases or fairness, use a dedicated lock library — Redlock or a similar primitive. The framework doesn't ship a lock library (lots of nuance around correctness; one-size-fits-all is the wrong shape).

## TTL semantics

- **`ttlSec: undefined`** — no expiry. The value lives until `del`, `invalidateTag`, or `clear`. Risky for things that should age out; useful for permanent-but-expensive computation results.
- **`ttlSec: <positive number>`** — Redis `EX` (seconds). Tag membership records inherit the same TTL.
- **`ttlSec: 0` or negative** — coerced to `undefined` (no expiry). Use `del` to delete now instead.

There's no per-key TTL refresh on `get`. If you want a sliding window, set on each access; that's expensive but explicit. Prefer fixed TTLs that match the staleness budget for the underlying data.

## Connection sharing

The framework's `RedisProvider` returns a single shared client used by:

- `RedisCache` (this page)
- `rateLimit` middleware
- `idempotency` middleware
- BullMQ queues + workers
- Any consumer code that calls `redisProvider.getClient()`

Connection pooling is the client's responsibility (node-redis pools internally; ioredis manages reconnection). Sharing one client across subsystems is correct — Redis multiplexes commands over a single connection efficiently. Don't spawn a per-subsystem client unless you have a specific reason (e.g., subscribing on a separate connection because pubsub blocks).

## In-memory backend (`InMemoryCache`)

```ts
import { InMemoryCache } from "@sixthsummit/ship-api/app/services/cache/InMemoryCache";

const cache = new InMemoryCache();
```

For tests and single-process dev. Same interface, backed by a `Map<string, { value, expiresAt, tags }>`. TTL is enforced lazily on `get` (the entry is checked against `Date.now()` and removed if expired).

Don't use this in production multi-replica deployments — each pod has its own in-memory cache, so writes on one don't propagate to others. The whole point of `RedisCache` is shared state.

## Cache vs ETag / `Cache-Control`

This page is about server-side caching — values stored in Redis to avoid recomputing them. HTTP-level caching (browser caches, CDN caches, conditional requests with ETags) is orthogonal. The framework doesn't ship ETag generation; if you need it, compute the hash inside your handler and set `c.header("ETag", ...)` + check `If-None-Match`. There's nothing framework-specific about it.

## Operational concerns

**Cache hits don't drop database load to zero.** Even with a 99% hit rate, the 1% miss rate is the rate at which your DB sees traffic. If you can't survive that miss rate at full throughput (cold cache scenarios — restart, mass invalidation), the cache is a latency optimization but not a load reduction. Test cold-cache behavior explicitly.

**Cache expiry creates thundering herds.** When 1,000 keys expire simultaneously, 1,000 misses hit the DB simultaneously. Two mitigations:

1. **Jitter the TTLs.** Instead of `ttlSec: 300`, use `ttlSec: 300 + Math.floor(Math.random() * 60)`. Spread expirations over a 60-second window.
2. **Stale-while-revalidate.** Return the stale value from cache, asynchronously refresh. The framework doesn't ship this (varies by use case); it's straightforward to layer on top of `cached()`.

**Memory pressure → eviction policy.** Configure Redis with `maxmemory-policy allkeys-lru` (or `volatile-lru` if you want to protect untagged values). Without an eviction policy, Redis returns OOM errors on writes when memory fills.

**Cache invalidation is hard.** The two hard problems in computer science are cache invalidation, naming things, and off-by-one errors. The framework gives you the primitives (TTL, tags, explicit `del`); the *strategy* — what to invalidate, when — is application-specific and easy to get wrong. Start with short TTLs and explicit `invalidateTag` on writes; add long TTLs only when you have evidence of cache pressure.

## Source

- [`packages/core/src/app/services/cache/Cache.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/cache/Cache.ts) — the interface
- [`packages/core/src/app/services/cache/RedisCache.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/cache/RedisCache.ts) — Redis implementation with msgpackr + tags
- [`packages/core/src/app/services/cache/InMemoryCache.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/cache/InMemoryCache.ts) — in-process fallback
- [`packages/core/src/app/services/cache/cached.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/cache/cached.ts) — the cache-aside helper
