# @sixthsummit/ship-testing

## 1.1.0

### Minor Changes

- [#132](https://github.com/SixthSummit/ship-api/pull/132) [`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit actor kinds, a durable transactional outbox, and executor-enforced idempotency (ADR-0014).

  - `OperationActor` now carries `kind` (`human` | `system` | `provider`); `systemActor()`, `providerActor()`, `systemAccess()` and `providerAccess(id)` are new. Every actor a handler sees has `kind`. An actor without `kind` (built on ship-core 1.0) is still accepted by resolvers and `executor.run()` and normalised to `human`; `isOperationActor()` checks the normalised shape. Build actors with `operationActor()` (defaults to `human`).
  - `defineOutbox`, `outboxIntent`, `outboxDependency`, `defineOutboxDispatcher`, `defineOutboxCleanup` and the `OutboxBackend` contract deliver intents at-least-once with leases, bounded retry, dead-lettering and retention.
  - `idempotency: { key, windowMs, store }` on `defineOperation` replays stored results, reports `IDEMPOTENT_IN_FLIGHT` (409), and releases claims on failure.
  - `@sixthsummit/ship-drizzle`: `createDrizzleOutbox`, `shipOutboxTable`, `createDrizzleIdempotencyStore`, `shipIdempotencyTable`, `transactionForScope`.
  - `@sixthsummit/ship-testing`: `createInMemoryOutbox`, `createInMemoryIdempotencyStore`, `drainOutbox`.
  - `@sixthsummit/ship-contract`: projects `system`/`provider` access, idempotency windows and the `IDEMPOTENT_IN_FLIGHT` failure.

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `createInMemoryJobBackend`, `createInMemoryLockProvider`, `runJobOnce`, `nextOccurrence` and the shared `jobBackendConformance` suite (`@sixthsummit/ship-testing/jobs`, `/jobs-conformance`).

- [#135](https://github.com/SixthSummit/ship-api/pull/135) [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a declared read cache with framework-owned keys and durable tag invalidation (ADR-0019).

  - `defineOperation` accepts `cache: { ttlMs, scope: "actor" | "tenant" | "public", vary?, tags?, tenant? }` on `transaction: "none"` and `"read"` operations. The executor derives every key from the operation id, its graph version, the actor id or the identifier of an authentic `TenantScope`, the canonical validated input and `vary` — a consumer cannot supply a raw key. Hits replay the stored success and are marked `cache: "hit"`; declared failures are never cached; concurrent misses for one key are coalesced. Streaming operations bypass the read cache: `cache` on a `transport.response.mode: "stream"` operation fails compilation with `SHIP_OPERATION_STREAM_CACHE_FORBIDDEN`.
  - `invalidates: readonly string[]` on `transaction: "write"` operations records one durable purge intent per tag through the framework-owned `ship-cache.invalidation` outbox inside the write transaction, so a rollback leaves none. Mount `defineCacheInvalidationModule({ cache, outbox })` once; the generated dispatcher performs the purge after commit. Invalidation is eventual.
  - `CacheBackend` (`get`, `set`, `del`, `delByTag`, `health`, optional `singleFlight`) is bound with `cacheBackendDependency(id)`. New diagnostics: `SHIP_CACHE_TRANSACTION_FORBIDDEN`, `SHIP_CACHE_BACKEND_UNBOUND`, `SHIP_CACHE_SCOPE_ACTOR_INVALID`, `SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID`, `SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING`, `SHIP_CACHE_PROVIDER_LIFETIME_INVALID`, and the `SHIP_CACHE_TAG_UNKNOWN` warning carried in `graph.diagnostics`.
  - `@sixthsummit/ship-cache-redis` (new): `createRedisCacheBackend` stores JSON with millisecond TTLs and TTL-matched Redis tag sets, driver-free through a small `RedisLike` client interface.
  - `@sixthsummit/ship-testing`: `createInMemoryCacheBackend` and the runner-agnostic `cacheBackendConformance` suite both adapters pass.
  - `@sixthsummit/ship-hono`: cached responses carry `x-ship-cache: hit|miss` (a reserved header) and the declared `Cache-Control`.
  - `@sixthsummit/ship-contract`: the client contract and OpenAPI carry cache policy, `Cache-Control` and `X-Ship-Cache`.
  - `@sixthsummit/ship-cli`: `inspect` prints cache policy and invalidated tags, `affected` follows tag edges from a write to the cached reads it purges, and `check` reports compilation warnings.

- [#138](https://github.com/SixthSummit/ship-api/pull/138) [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add inbound webhook operations (ADR-0018).

  - `@sixthsummit/ship-core`: `defineWebhook` compiles a bounded raw-body POST operation with `providerAccess`, a pure `WebhookVerifier` contract with explicit guarantees, rotatable `WebhookSecretSource`s, executor-enforced idempotency with a declared in-flight policy, inline or enqueue (receive-then-process) modes, `webhookIntent`, `defineWebhookReplay`, `defineWebhookCleanup`, the `WebhookEventStore` contract, a `WebhookObserver` hook, and edge-safe WebCrypto helpers. The executor reports `SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE` for store outages and marks replayed results with `replayed: true`.
  - `@sixthsummit/ship-hono`: `createHonoAdapter({ webhooks: { publicBaseUrl, observer } })` verifies exact bytes before any actor exists, derives canonical URLs from the declared base URL, and maps outcomes to stable `WEBHOOK_*` responses.
  - `@sixthsummit/ship-drizzle`: `shipWebhookEventsTable` and `createDrizzleWebhookEventStore` with retention cleanup that never deletes undispatched events.
  - `@sixthsummit/ship-testing`: `createInMemoryWebhookEventStore`, `fakeWebhookProvider`, and `purgeExpired` on the in-memory idempotency store.
  - `@sixthsummit/ship-contract`: webhook operations are excluded from the browser manifest and documented in OpenAPI under `x-ship-webhook`.
  - `@sixthsummit/ship-observability-otel`: `createWebhookMetrics` records receive outcomes, verification failures, duplicates and receive-to-dispatch lag.
  - `@sixthsummit/ship-webhooks` (new, `0.1.0-alpha.0`): subpath verifiers for Stripe, GitHub, Slack, Twilio, Resend, HighLevel and a documented shared-secret fallback.

- [#144](https://github.com/SixthSummit/ship-api/pull/144) [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve declared caching and jobs conformance (ADR-0019 and ADR-0015 addenda).

  - `Cache-Control` projects `public` only when the operation's access is `publicAccess()`; a `scope: "public"` read behind any other access projects `private, max-age=N` everywhere (`ship-hono`, graph, contract, OpenAPI). `cacheControlHeader(cache, access?)` takes the access; omitted, it projects private. New diagnostics: `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (warning), `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (error, optional-identity access).
  - `invalidates` accepts `{ tag, scope: "actor" }` and `{ tag, scope: "tenant", tenant }` beside plain tags. Actor- and tenant-scoped reads store entries under `scopedCacheTag(tag, scopeKey)` as well as the plain tag; a scoped write records `{ tag, scope }` and the dispatcher purges only that subject's entries. Compiled `operation.invalidates` becomes `{ tag, scope, tenant? }[]`; the graph adds `invalidatesScoped`. New diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error), `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). Executor: `SHIP_OPERATION_CACHE_ACTOR_INVALID`.
  - `cache.vary(input, subject)` receives a read-only `{ actor, context }`; `SHIP_CACHE_VARY_SUBJECT_PUBLIC` warns when a public read's `vary` reads it.
  - `defineCacheInvalidationModule({ backend })` binds and exports the `cacheBackendDependency` token so modules with cached reads import `ship-cache` and bind nothing.
  - `@sixthsummit/ship-testing`: `cacheBackendConformance` proves scoped tags stay independent; `@sixthsummit/ship-cache-redis` passes it and the executor-level tenant/actor isolation test against real Redis.
  - `@sixthsummit/ship-cli`: `inspect app|module` lists declared and framework-introduced permissions (`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`); `inspect operation` renders scoped invalidations.
  - Jobs: `defineJob` accepts `retention.completedMs: 0` / `deadLetteredMs: 0` (collect on the next sweep); `startJobRuntime` returns `liveness(now?)` with per-job `lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`completed`/`failed`/`lagMs`; `ship-hono` adds `jobLivenessRoute({ runtime, staleAfterMs?, path? })` and `projectJobLiveness`; `SHIP_MODULE_OPERATION_ID_MISMATCH` explains the job-id and `defineJobManagement` prefix rule.

- [#137](https://github.com/SixthSummit/ship-api/pull/137) [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `createInMemoryRealtimeBackend()`, `collectPublishes(app)`, and the
  `realtimeBackendConformance()` suite every realtime adapter must pass, exported from
  the root entry and `@sixthsummit/ship-testing/realtime`.

- [#145](https://github.com/SixthSummit/ship-api/pull/145) [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve realtime and webhook replay conformance (ADR-0017 and ADR-0018 addenda).

  - Presence: `RealtimePresence.actorOnline({ channelId, scopeKey, actorId, ... })` answers cluster-wide whether an actor holds a live subscription; `snapshot` takes `{ cursor?, limit? }` and returns `{ count, actorIds, nextCursor? }` (default page 100, clamped to 1,000; `page-invalid` for malformed paging). `pagePresenceMembers`, `REALTIME_PRESENCE_DEFAULT_LIMIT` and `REALTIME_PRESENCE_MAX_LIMIT` are exported; the in-memory backend and the Socket.IO adapter share them and the conformance suite asserts both. Wire: `ship:presence.snapshot` gains `cursor`/`limit`/`nextCursor` and `INVALID_PAGE`; `ship:presence.online` is new.
  - Publishers: `createChannelPublisherRegistry(channels | { modules }, backend)` derives `get`/`has`/`for`/`publish` and `providers` from the declarations; `defineRealtimePublicationModule` exposes its registry as `publishers`. `AnyChannelPublisher`, `isChannelPublisher` and `narrowChannelPublisher` give generic bridges an erased, runtime-validated publish and a typed way back.
  - Executor: `ApplicationExecutor.tryRun()` returns `OperationExecutionFailure` (the HTTP adapter's 500 envelope plus `cause`) where `run()` throws an `OperationExecutionError`; `operationExecutionFailure()` builds the envelope. `run()` is unchanged.
  - Dispatch: `dispatchRealtimePublications(executor)` is the one dispatch pass; `startRealtimePublicationRunner(executor, { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError? })` loops it with bounded bursts, failure backoff, `runOnce()` and graceful `stop()`; `defineRealtimePublicationDispatchJob({ trigger, executor })` runs it as a declared single-runner job. `@sixthsummit/ship-realtime-socketio` adds `createPublicationRunnerMetrics()` (`ship.realtime.publication.runs`, `.run.duration`, `.records`). New `RealtimeError` codes `SHIP_REALTIME_DISPATCH_FAILED` and `SHIP_REALTIME_RUNNER_INVALID`.
  - Manifest projection: `ProjectableRuntimeSchema`, `CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS`, `hasContractProjection` and `isManifestProjectable` name the convention; compilation warns `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE`; `ChannelGraphNode.payload` gains `projectable`; `defineModule` keeps `channels` typed per module (an omitted list is the empty tuple); `ApplicationContractOf` gains `channels` with `ChannelPayloadOf` and `ChannelPayloadNotProjectable<id>`.
  - Webhook replay: `defineWebhookReplay` accepts any single `:name` path parameter as the event id (`WebhookReplayPathParameter<TPath>`, params keyed by the name) with an optional `transport.eventIdParameter` cross-check; the JSON body fallback is unchanged.

- [#140](https://github.com/SixthSummit/ship-api/pull/140) [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `drainRealtimePublications(executor)` (root entry and `@sixthsummit/ship-testing/realtime`),
  which runs `ship-realtime.publication.dispatch` until idle so `collectPublishes()` observes
  publications recorded by `transaction: "write"` operations.

- [#154](https://github.com/SixthSummit/ship-api/pull/154) [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Dispatchers now claim persisted receipts whose intent ID is no longer declared and dead-letter them for inspection, instead of leaving them pending indefinitely. The Drizzle and in-memory backends implement an atomic unknown-ID claim that respects intent partitions. Custom unpartitioned backends remain compatible through an unfiltered claim; partitioned custom backends must implement `claimUnknownDue`.

### Patch Changes

- [#148](https://github.com/SixthSummit/ship-api/pull/148) [`b70c5a3`](https://github.com/SixthSummit/ship-api/commit/b70c5a321534f6217fd76197dc92d7da959529d3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `jobBackendConformance` waits for a backend's own completion signal (`health()` reporting a run neither waiting nor active) before asserting settled counts and retention cleanup, instead of treating the handler's return as completion; the suite no longer flakes under CPU contention against backends that record the outcome after the handler resolves.

- [#152](https://github.com/SixthSummit/ship-api/pull/152) [`7bcbe25`](https://github.com/SixthSummit/ship-api/commit/7bcbe25b16a4f618ce3fe9cbff87a49a3c82f45a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `@sixthsummit/ship-testing/postgres` exports `createPostgresTestPool(connectionString, options)`, a `pg.Pool` factory that attaches the pool-level `error` listener, and `setupPostgresTestDb` now uses it for its own pool. Without the listener, stopping the container while an idle client is still connected surfaces `57P01 terminating connection due to administrator command` as an uncaught exception after a passing suite.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish behavioral parity utilities and the real PostgreSQL Testcontainers harness as the development-only `@sixthsummit/ship-testing` trust zone. The monolithic testing entry becomes an optional compatibility re-export.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`8de94e0`](https://github.com/SixthSummit/ship-api/commit/8de94e0bf393b25e351a4a0f565723be440d7b5f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Require Node.js 22.22 or newer, matching the minimum runtime required by the package's locked
  Testcontainers dependency.

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish behavioral parity utilities and the real PostgreSQL Testcontainers harness as the development-only `@sixthsummit/ship-testing` trust zone. The monolithic testing entry becomes an optional compatibility re-export.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`8de94e0`](https://github.com/SixthSummit/ship-api/commit/8de94e0bf393b25e351a4a0f565723be440d7b5f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Require Node.js 22.22 or newer, matching the minimum runtime required by the package's locked
  Testcontainers dependency.
