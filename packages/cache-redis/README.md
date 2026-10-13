# @sixthsummit/ship-cache-redis

Redis `CacheBackend` adapter for declared Ship read caching (ADR-0019).

The kernel owns the cache declaration, key derivation and hit/miss policy; this
package only stores bytes. It is Node-only by design — the kernel stays
edge-safe because the Redis adapter lives outside it.

```ts
import { cacheBackendDependency, defineCacheInvalidationModule } from "@sixthsummit/ship-core";
import { createRedisCacheBackend } from "@sixthsummit/ship-cache-redis";
import Redis from "ioredis";

const cacheToken = cacheBackendDependency("platform.cache");
const cache = createRedisCacheBackend({
  client: new Redis(process.env.REDIS_URL),
  // Namespace per service and release so a deploy cannot read stale entries.
  keyPrefix: "billing:4.0.0:",
});

const module = defineModule({
  id: "billing",
  operations: [summary],
  providers: [], // ship-cache owns the backend binding below
  imports: ["ship-cache"],
  exports: [],
});

// Mounted once: binds and exports `cacheToken`, and purges declared
// `invalidates` after commit. Introduces the `ship.outbox:manage` permission.
const invalidation = defineCacheInvalidationModule({
  cache,
  outbox: outboxBackend,
  backend: cacheToken,
});
```

The client is injected through the small `RedisLike` interface, so this package
depends on no Redis driver: use `ioredis`, a cluster client, or a test fake.

## Behavior

- Values are stored as JSON with a millisecond TTL (`SET … PX`).
- Tagged writes `SADD` the namespaced key into `<keyPrefix><tagPrefix><tag>` and
  give the tag set the entry TTL, so tag bookkeeping never outlives the data.
- `delByTag` reads the members, deletes them, and drops the set. It is called by
  the framework's cache-invalidation dispatcher after a write commits. An
  actor- or tenant-scoped entry is also indexed under `<tag>@actor:<id>` /
  `<tag>@tenant:<key>`, so a scoped write purges one subject's set and leaves
  every other subject's entries warm; the plain tag still purges them all.
- `singleFlight` coalesces concurrent misses for one key **within one process**.
  Cross-process stampede control is not part of the declared contract.
- A stored value this adapter cannot parse is treated as a miss and deleted.

`cacheBackendConformance` from `@sixthsummit/ship-testing/cache` runs against
this adapter in both the unit suite (fake client) and the integration suite
(real Redis via testcontainers).
