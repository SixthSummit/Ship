# `@sixthsummit/ship-testing`

Reusable behavioral-parity fixtures and a Testcontainers-backed PostgreSQL
harness. Install this package as a development dependency; it is deliberately a
separate trust zone and is never pulled into Ship runtime packages.

`createInMemoryOutbox()`, `createInMemoryIdempotencyStore()` and
`drainOutbox()` let unit tests run the outbox dispatcher without a database.

## Cache

`createInMemoryCacheBackend()` is an LRU `CacheBackend` for tests and
single-process development, and `cacheBackendConformance()` is the behavioral
suite every adapter passes — including that a scope-qualified tag
(`<tag>@tenant:<key>`, `<tag>@actor:<id>`) purges only its own entries while
the plain tag still reaches them all.

## Realtime

- `createInMemoryRealtimeBackend({ channels, tenantScopes? })` is the process-local `RealtimeBackend` for unit tests and transport smoke fixtures.
- `collectPublishes(app)` recompiles a compiled application so every channel publication records into one in-memory backend; run the returned `application` and read `publishes()`.
- `realtimeBackendConformance({ createBackend, test })` registers the behavioral contract every adapter must pass (authorized delivery, fail-closed authorization, per-scope sequencing, presence dedupe, paged snapshots and `actorOnline`, coalescing, disconnect cleanup, health).

## Webhooks

- `createInMemoryWebhookEventStore({ outbox, idempotency })` is the in-memory twin of the Drizzle webhook event store.
- `fakeWebhookProvider()` is a complete HMAC provider (verifier plus `sign()` helper) built only from the public kernel contract, proving a consumer-defined verifier binds without a registry.

## Jobs

`createInMemoryJobBackend()`, `createInMemoryLockProvider()` and `runJobOnce()`
run declared jobs without Redis, and `jobBackendConformance()` is the shared
behavioral suite every `JobBackend` adapter passes.
