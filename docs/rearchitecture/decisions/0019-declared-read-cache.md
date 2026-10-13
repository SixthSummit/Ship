# ADR-0019: Declared read cache with framework-owned keys and durable invalidation

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Read caching declaration, cache key derivation, cache backend contract, tag invalidation, HTTP and contract projection
- **Related:** [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0008](./0008-authorized-tenant-capabilities.md) · [ADR-0010](./0010-declared-immediate-effects.md) · [ADR-0014](./0014-actor-kinds-and-durable-outbox-delivery.md)

## Context

The compatibility distribution ships `Cache`, `RedisCache`, `InMemoryCache` and a `cached(cache, key, ttl, fn)` read-through helper. They work, and every one of their failure modes comes from the same place: the consumer writes the key. A key that omits the tenant serves one tenant's rows to another; a key that omits the actor leaks a personalized read; a key that omits the schema version serves a shape the client can no longer parse. None of this is visible in the application graph, so no review, diagnostic or contract can catch it — the cache is invisible infrastructure that quietly widens the blast radius of a typo.

Invalidation has the mirror problem. `cache.invalidateTag(tag)` is a call a handler makes, so whether it runs at all depends on where in the handler it sits and whether the surrounding transaction committed. A purge issued before commit invalidates work that may roll back; a purge issued after commit in the same process is lost when that process dies.

The kernel must stay edge-safe (ADR-0001), so a Redis client cannot live in it.

## Decision

### Caching is a declaration on the operation

A read operation declares:

```ts
cache: {
  ttlMs: number;
  scope: "actor" | "tenant" | "public";
  vary?: (input) => readonly string[];
  tags?: readonly string[];
  tenant?: (arguments_) => TenantScope | Promise<TenantScope>; // required for tenant scope
}
```

Only `transaction: "none"` and `transaction: "read"` operations may declare it; `cache` on a write fails compilation with `SHIP_CACHE_TRANSACTION_FORBIDDEN`. The operation binds a backend with `cacheBackendDependency(id)`; declaring a cache without one fails with `SHIP_CACHE_BACKEND_UNBOUND`, and `scope: "actor"` on an operation whose access does not require an actor fails with `SHIP_CACHE_SCOPE_ACTOR_INVALID`. A streaming operation ([ADR-0016](./0016-streaming-response-representation.md)) bypasses the read cache: its frames are delivered to the adapter as they are emitted and can never be stored or replayed, so `cache` on a `transport.response.mode: "stream"` operation fails with `SHIP_OPERATION_STREAM_CACHE_FORBIDDEN`, and the executor never consults a backend for a stream. `invalidates` on a write is unaffected by streaming.

### The framework owns the key

The executor derives every key as a digest of the operation id, a version derived from the operation's own projected graph node, the scope key, the canonical form of the **validated** input, and the declared `vary` values. A consumer cannot supply a raw key, so the key cannot omit a dimension the framework considers load-bearing.

The scope key is the actor id, the identifier of an **authentic** `TenantScope` (ADR-0008), or the literal `public`. Tenant scope is deliberately not a string from the request: the declaration returns a scope issued by the application's own authority, the framework verifies the capability brand, and a forged or raw value is rejected with `SHIP_OPERATION_CACHE_TENANT_INVALID`. An authority that denies the actor fails the operation instead of caching anything.

Because the version comes from the projected graph node, changing an operation's schemas, access, transport or cache policy retires its existing entries rather than serving a stale shape.

### A miss runs, a success is stored, a failure never is

After access and input validation, the executor looks the key up. A hit returns the stored success result and marks it `cache: "hit"`; a miss runs the operation and stores the result only when it succeeds, marking it `cache: "miss"`. Declared failures raise `OperationFailure` and are never stored, so an operation cannot cache its own 404. Concurrent misses for one key are coalesced per process, by the adapter's `singleFlight` when it provides one and by the executor otherwise, so a cold key does not stampede the handler.

### Invalidation is a durable intent, not a callback

A write operation declares `invalidates: readonly string[]`. The executor records one purge intent per tag through the framework-owned `ship-cache.invalidation` outbox **inside the write transaction** (ADR-0014). The intent therefore commits with the change it describes and a rollback leaves none. Nothing is purged at that point: a separate `ship-cache.invalidation.dispatch` operation — an ordinary system-access dispatcher the consumer mounts once via `defineCacheInvalidationModule` — performs `CacheBackend.delByTag` afterwards.

**Invalidation is eventual.** Between commit and dispatch a cached read may still return the pre-write value. That window is bounded by dispatch frequency and by `ttlMs`, and it is the reason the declared `Cache-Control` should be read as the staleness a caller accepts rather than a promise of freshness. Applications that cannot tolerate the window should not cache that read.

`invalidates` requires `transaction: "write"` (`SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID`). A non-transactional write has no transaction for the intent to commit with, so recording one would reintroduce exactly the process-local, lose-on-crash purge this decision rejects. Such an operation either declares a write transaction or does not participate in tag invalidation.

A tag named in `invalidates` that no cached operation declares is a **warning**, `SHIP_CACHE_TAG_UNKNOWN`, carried in `graph.diagnostics` rather than a compilation failure: a write may legitimately land before the read that will be tagged, and a typo is still surfaced by `ship-api check`.

### The backend contract is small and the adapter is separate

`CacheBackend` is `get`, `set(key, value, { ttlMs, tags })`, `del`, `delByTag`, `health`, plus an optional `singleFlight`. It lives in the kernel; the Redis implementation lives in `@sixthsummit/ship-cache-redis`, a Node-only package, so the kernel stays edge-safe. `@sixthsummit/ship-testing` ships an in-memory LRU backend and `cacheBackendConformance`, the runner-agnostic suite both adapters pass.

### The policy is visible everywhere the graph is

Cache scope, TTL, tags, backend and the projected `Cache-Control` appear on the operation node in `.ship/graph.json` and `ship-api inspect`; `ship-api affected` follows tag edges from an invalidating write to the cached reads it purges. The client contract and OpenAPI carry the same policy, and `ship-hono` emits `x-ship-cache: hit|miss` plus `private, max-age=…` for actor and tenant scope or `public, max-age=…` for public scope. `x-ship-cache` is a reserved response header, so an operation cannot forge a hit.

## Consequences

- A cross-tenant or cross-actor cache hit is not expressible: the mistake that made `cached()` dangerous is removed rather than documented.
- Caching is reviewable. Which reads are cached, for how long, under what scope, and which writes purge them is in the graph and the contract.
- Invalidation survives a crash between commit and purge, at the cost of being eventual and of requiring the cache-invalidation module to be mounted once.
- A cached read is one extra round trip to the backend on a miss; a backend outage surfaces as an operation failure rather than a silent bypass, which is deliberate — a cache that silently disappears hides capacity problems until they are outages.
- Stampede protection is per process. Cross-process coalescing would require a lease primitive in the backend contract and is not part of this decision.
- The compatibility `Cache`, `cached()` and `RedisCache` are untouched and remain available to compatibility applications.

## Rejected alternatives

### Consumer-supplied cache keys, or a `key(input)` hook

Rejected. Every real failure mode of the compatibility helper is a key that omitted a dimension. A hook that returns a key reintroduces all of them while looking declarative.

### Purging after commit in the executor

Rejected, reaffirming ADR-0014. A post-commit purge is a process-local callback: a crash in that window leaves a cached value that nothing will ever invalidate, and there is no record that the purge was owed.

### Purging before or inside the transaction

Rejected. A purge that runs before commit invalidates on behalf of a change that may roll back, and re-population by a concurrent read immediately restores the stale value.

### A cache adapter in the kernel

Rejected. A Redis driver in the kernel breaks edge compatibility; the contract belongs in the kernel and the driver in its own package, exactly as with auth and telemetry adapters.

### Caching declared failures

Rejected. Negative caching is a per-operation policy with its own expiry semantics; storing a declared failure under the same key and TTL as a success would make a transient dependency outage durable.

## Addendum 2026-09-18: cache scoping refinements

The accepted text above is unchanged. The two second-consumer proofs found five
gaps in the projection and the invalidation grammar; this section records what
changed and the guarantees it adds.

### `Cache-Control` never says `public` for a protected read

`scope: "public"` describes the **key** — one entry for every caller allowed
in — not who may store the response. The original projection emitted
`public, max-age=N` for any `scope: "public"` read, which invited a shared
cache between the client and the app to store a permission-gated body.
`cacheControlHeader(cache, access)` now projects `public` only when the
operation's access is `publicAccess()`; every other access, and an absent one,
projects `private, max-age=N`. `ship-hono`, the graph node, the client
contract and OpenAPI all carry the corrected value.

Two diagnostics make the key/access mismatch visible at compile time:

- `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (**warning**) — `scope: "public"` on an
  operation whose access is not public. The author is told that every caller
  allowed in shares one stored result; the projection stays private.
- `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (**error**) — `scope: "public"` on an
  `optionalIdentityAccess()` operation. Optional identity exists so a handler
  can answer differently for an anonymous and an identified caller; one shared
  entry would serve whichever answer landed first to everyone. This is the only
  case the compiler can *prove* varies by actor; for authenticated, permission,
  system and provider access the handler's output is opaque, so the warning
  stands and the author confirms.

### `vary` sees the subject, and a public read that uses it is actor-scoped

`vary(input, subject)` receives a read-only `{ actor, context }` beside the
validated input, so a read whose body legitimately varies by a
credential-derived subject has a declarative key without a request rewrite. A
`scope: "public"` read whose `vary` reads that subject is actor scope in
disguise: `SHIP_CACHE_VARY_SUBJECT_PUBLIC` (**warning**) fires when a public
read declares a `vary` that names its second parameter (arity is the cheap,
honest signal; a `vary` that ignores the argument still keys correctly).

### Scoped invalidation: purge one subject, not every subject

Tags were global: `invalidates: ["team.roster"]` on one tenant's write purged
every tenant's roster, and one user marking one notification read evicted every
user's inbox. `invalidates` now accepts three forms, mirroring how the cached
read's key was scoped:

```ts
invalidates: [
  "catalogue",                                    // global: every entry under the tag
  { tag: "inbox", scope: "actor" },               // the writing actor's entries only
  { tag: "roster", scope: "tenant", tenant },     // the derived tenant's entries only
]
```

An actor- or tenant-scoped **read** stores each entry under its plain tags and
under `scopedCacheTag(tag, scopeKey)` — `<tag>@actor:<id>` or
`<tag>@tenant:<key>`, the same scope key that keyed the entry. A scoped write
records the purge intent as `{ tag, scope: <scopeKey> }`; the dispatcher purges
the qualified tag and every other subject's entries stay warm. The plain form
still reaches them all. `CacheBackend.delByTag` is unchanged — a qualified tag
is just a tag — and `cacheBackendConformance` now proves an adapter keeps
scoped tags independent. The tenant deriver on a write has the same contract as
`cache.tenant` on a read: it must return an authentic `TenantScope`, and a
denied actor fails the write before any intent is recorded
(`SHIP_OPERATION_CACHE_TENANT_INVALID`); an actor-scoped purge on a write that
ran without an actor fails with `SHIP_OPERATION_CACHE_ACTOR_INVALID`.

Compile-time checks: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (**error**) rejects
an actor-scoped purge on a write whose access requires no actor;
`SHIP_CACHE_TAG_SCOPE_UNMATCHED` (**warning**) flags a scoped purge of a tag
that no read of that scope declares, because it would purge nothing. The graph
node carries `invalidatesScoped: [{ tag, scope }]` beside the plain
`invalidates` tag list, and `ship-api inspect` renders `tag (tenant)`.

Proven against real Redis: one tenant's write leaves the other tenant's entry a
hit; one actor's write leaves the other actor's entry a hit.

### The invalidation module may own the backend binding

A dependency token is bound in exactly one module, which forced a consumer
with cached reads in two unrelated modules to invent an empty module just to
own `cacheBackendDependency`. `defineCacheInvalidationModule({ cache, outbox,
backend })` now also binds `backend` to `cache` and exports it, so every module
with a cached read imports `ship-cache` and binds nothing. Omitting `backend`
keeps the previous behaviour.

### The module introduces a framework permission

Mounting `ship-cache` generates dead-letter operations gated by
`ship.outbox:manage`. That slug — like `ship.jobs:manage` and
`ship.webhooks:replay` — is a framework permission the consumer's own
authorization model must grant. The kernel README and the migration guide list
every framework permission, and `ship-api inspect app|module` lists the
permissions each module introduces, framework ones flagged.
