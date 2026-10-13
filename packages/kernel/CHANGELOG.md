# @sixthsummit/ship-core

## 1.1.0

### Minor Changes

- [#132](https://github.com/SixthSummit/ship-api/pull/132) [`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit actor kinds, a durable transactional outbox, and executor-enforced idempotency (ADR-0014).

  - `OperationActor` now carries `kind` (`human` | `system` | `provider`); `systemActor()`, `providerActor()`, `systemAccess()` and `providerAccess(id)` are new. Every actor a handler sees has `kind`. An actor without `kind` (built on ship-core 1.0) is still accepted by resolvers and `executor.run()` and normalised to `human`; `isOperationActor()` checks the normalised shape. Build actors with `operationActor()` (defaults to `human`).
  - `defineOutbox`, `outboxIntent`, `outboxDependency`, `defineOutboxDispatcher`, `defineOutboxCleanup` and the `OutboxBackend` contract deliver intents at-least-once with leases, bounded retry, dead-lettering and retention.
  - `idempotency: { key, windowMs, store }` on `defineOperation` replays stored results, reports `IDEMPOTENT_IN_FLIGHT` (409), and releases claims on failure.
  - `@sixthsummit/ship-drizzle`: `createDrizzleOutbox`, `shipOutboxTable`, `createDrizzleIdempotencyStore`, `shipIdempotencyTable`, `transactionForScope`.
  - `@sixthsummit/ship-testing`: `createInMemoryOutbox`, `createInMemoryIdempotencyStore`, `drainOutbox`.
  - `@sixthsummit/ship-contract`: projects `system`/`provider` access, idempotency windows and the `IDEMPOTENT_IN_FLIGHT` failure.

- [#169](https://github.com/SixthSummit/ship-api/pull/169) [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add optional bounded result observation to durable job backends and a synchronous HTTP job projection. BullMQ retains completed results and final failures while a timed-out HTTP request returns the durable run ID for reconciliation without cancelling the job. A delivery dedupe key can reuse a retained terminal run, preventing a scheduler retry from replaying the effect.

- [#160](https://github.com/SixthSummit/ship-api/pull/160) [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow declared operation failures to carry safe, required response headers such as `Retry-After`, and project those declarations through Hono, client contracts, and OpenAPI.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Support declared, bodyless HTTP redirects with validated Location headers, truthful OpenAPI responses, and explicit manual Fetch behavior for opaque browser redirects.

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add declared jobs and schedules (ADR-0015): `defineJob` with schedule, interval, enqueue and http triggers compiles into a system-actor operation with a `job` transport; per-key single-runner leases through the `LockProvider` contract (`JOB_LOCK_HELD`), `JobBackend`, `jobDependency`, `jobBackendDependency`, `lockProviderDependency`, `defineJobManagement` (`ship.jobs:manage`), `defineJobCleanup`, `startJobRuntime`, `defineApp({ runtime })`, a `jobs` graph projection and warning-severity diagnostics retained on `app.diagnostics`. Framework schema builders are exported.

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

- [#149](https://github.com/SixthSummit/ship-api/pull/149) [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the two outbox findings of the M10 capacity baseline (SAPI-114, ADR-0014 and ADR-0017 addenda).

  - `@sixthsummit/ship-drizzle`: `shipOutboxTable()` adds the partial indexes `<table>_pending_idx` (`outbox_id, available_at, created_at` where `status = 'pending'`) and `<table>_lease_idx` (`outbox_id, lease_expires_at` where `status = 'claimed'`); generate a migration. `claimDue` retakes lease-expired rows first and fills the batch from pending rows through two ordered index scans with `FOR UPDATE SKIP LOCKED` instead of one `OR` that sorted every due row, so a 25-row claim costs about 5 ms at 200k pending rows instead of 71 ms.
  - `@sixthsummit/ship-core`: `startOutboxDispatchRunner(executor, "<outbox>.dispatch", { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError?, actor?, signal? })` is the adaptive dispatch loop (a full batch is followed by the next pass at once, bounded by `maxPassesPerCycle`; a short or empty batch waits the interval; failures back off; `runOnce()`; graceful `stop()`), with `dispatchOutbox` as the single pass, `OutboxRunnerError` (`SHIP_OUTBOX_RUNNER_INVALID`, `SHIP_OUTBOX_DISPATCH_FAILED`), `OUTBOX_RUNNER_ACTOR_ID` and the `DEFAULT_OUTBOX_RUNNER_*` constants. `startRealtimePublicationRunner` is that loop over the publication dispatcher; its pass and observer types are aliases of `OutboxDispatchRunnerPass` and `OutboxDispatchRunnerObserver`, and a short (non-empty) pass now waits the interval instead of passing again at once.
  - `OutboxDispatchResult` carries `batchSize`; the dispatcher's `describeOutboxOperation` role carries `batchSize` and an optional `roundsPerSecond`.
  - `defineOutbox({ expectedRatePerSecond? })` and `defineOutboxDispatcher(outbox, { roundsPerSecond? })` (also accepted by `defineRealtimePublicationOutbox`, `defineRealtimePublicationDispatcher` and `defineRealtimePublicationModule`) are optional; when both are declared the compiler warns `SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` if `batchSize x roundsPerSecond` is below the rate, and the outbox graph node projects `expectedRatePerSecond` and `dispatchCapacityPerSecond`. `SHIP_OUTBOX_EXPECTED_RATE_INVALID` rejects a non-positive rate.

- [#144](https://github.com/SixthSummit/ship-api/pull/144) [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve declared caching and jobs conformance (ADR-0019 and ADR-0015 addenda).

  - `Cache-Control` projects `public` only when the operation's access is `publicAccess()`; a `scope: "public"` read behind any other access projects `private, max-age=N` everywhere (`ship-hono`, graph, contract, OpenAPI). `cacheControlHeader(cache, access?)` takes the access; omitted, it projects private. New diagnostics: `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (warning), `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (error, optional-identity access).
  - `invalidates` accepts `{ tag, scope: "actor" }` and `{ tag, scope: "tenant", tenant }` beside plain tags. Actor- and tenant-scoped reads store entries under `scopedCacheTag(tag, scopeKey)` as well as the plain tag; a scoped write records `{ tag, scope }` and the dispatcher purges only that subject's entries. Compiled `operation.invalidates` becomes `{ tag, scope, tenant? }[]`; the graph adds `invalidatesScoped`. New diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error), `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). Executor: `SHIP_OPERATION_CACHE_ACTOR_INVALID`.
  - `cache.vary(input, subject)` receives a read-only `{ actor, context }`; `SHIP_CACHE_VARY_SUBJECT_PUBLIC` warns when a public read's `vary` reads it.
  - `defineCacheInvalidationModule({ backend })` binds and exports the `cacheBackendDependency` token so modules with cached reads import `ship-cache` and bind nothing.
  - `@sixthsummit/ship-testing`: `cacheBackendConformance` proves scoped tags stay independent; `@sixthsummit/ship-cache-redis` passes it and the executor-level tenant/actor isolation test against real Redis.
  - `@sixthsummit/ship-cli`: `inspect app|module` lists declared and framework-introduced permissions (`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`); `inspect operation` renders scoped invalidations.
  - Jobs: `defineJob` accepts `retention.completedMs: 0` / `deadLetteredMs: 0` (collect on the next sweep); `startJobRuntime` returns `liveness(now?)` with per-job `lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`completed`/`failed`/`lagMs`; `ship-hono` adds `jobLivenessRoute({ runtime, staleAfterMs?, path? })` and `projectJobLiveness`; `SHIP_MODULE_OPERATION_ID_MISMATCH` explains the job-id and `defineJobManagement` prefix rule.

- [#137](https://github.com/SixthSummit/ship-api/pull/137) [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add declared realtime publication (ADR-0017): `defineChannel` with actor, tenant, and
  resource scopes, per-channel `publication` effect tokens, `publishes` on operations,
  `channels` on modules, stable compile diagnostics, graph projection of channels, the
  transport-neutral `RealtimeBackend` contract, kernel-owned subscription authorization
  (`createSubscriptionAuthorizer`), `realtimeHandshakeOperation`, and a shared
  publication coalescer.

- [#145](https://github.com/SixthSummit/ship-api/pull/145) [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve realtime and webhook replay conformance (ADR-0017 and ADR-0018 addenda).

  - Presence: `RealtimePresence.actorOnline({ channelId, scopeKey, actorId, ... })` answers cluster-wide whether an actor holds a live subscription; `snapshot` takes `{ cursor?, limit? }` and returns `{ count, actorIds, nextCursor? }` (default page 100, clamped to 1,000; `page-invalid` for malformed paging). `pagePresenceMembers`, `REALTIME_PRESENCE_DEFAULT_LIMIT` and `REALTIME_PRESENCE_MAX_LIMIT` are exported; the in-memory backend and the Socket.IO adapter share them and the conformance suite asserts both. Wire: `ship:presence.snapshot` gains `cursor`/`limit`/`nextCursor` and `INVALID_PAGE`; `ship:presence.online` is new.
  - Publishers: `createChannelPublisherRegistry(channels | { modules }, backend)` derives `get`/`has`/`for`/`publish` and `providers` from the declarations; `defineRealtimePublicationModule` exposes its registry as `publishers`. `AnyChannelPublisher`, `isChannelPublisher` and `narrowChannelPublisher` give generic bridges an erased, runtime-validated publish and a typed way back.
  - Executor: `ApplicationExecutor.tryRun()` returns `OperationExecutionFailure` (the HTTP adapter's 500 envelope plus `cause`) where `run()` throws an `OperationExecutionError`; `operationExecutionFailure()` builds the envelope. `run()` is unchanged.
  - Dispatch: `dispatchRealtimePublications(executor)` is the one dispatch pass; `startRealtimePublicationRunner(executor, { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError? })` loops it with bounded bursts, failure backoff, `runOnce()` and graceful `stop()`; `defineRealtimePublicationDispatchJob({ trigger, executor })` runs it as a declared single-runner job. `@sixthsummit/ship-realtime-socketio` adds `createPublicationRunnerMetrics()` (`ship.realtime.publication.runs`, `.run.duration`, `.records`). New `RealtimeError` codes `SHIP_REALTIME_DISPATCH_FAILED` and `SHIP_REALTIME_RUNNER_INVALID`.
  - Manifest projection: `ProjectableRuntimeSchema`, `CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS`, `hasContractProjection` and `isManifestProjectable` name the convention; compilation warns `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE`; `ChannelGraphNode.payload` gains `projectable`; `defineModule` keeps `channels` typed per module (an omitted list is the empty tuple); `ApplicationContractOf` gains `channels` with `ChannelPayloadOf` and `ChannelPayloadNotProjectable<id>`.
  - Webhook replay: `defineWebhookReplay` accepts any single `:name` path parameter as the event id (`WebhookReplayPathParameter<TPath>`, params keyed by the name) with an optional `transport.eventIdParameter` cross-check; the JSON body fallback is unchanged.

- [#140](https://github.com/SixthSummit/ship-api/pull/140) [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Compose transactional realtime publication with the durable outbox (ADR-0017 addendum).

  - A `transaction: "write"` operation may declare `publishes`; its bound `channel.publication`
    resolves to a publisher that validates scope and payload like the immediate path and records a
    `{ scopeKey, payload }` intent in the write transaction through the framework outbox
    `ship-realtime.publication`. `publish()` accepts an optional `{ dedupeKey }`.
  - `defineRealtimePublicationOutbox`, `defineRealtimePublicationDispatcher` and
    `defineRealtimePublicationModule({ channels, realtime, outbox, retention? })` mount the outbox
    writer, one publisher provider per channel, `ship-realtime.publication.dispatch`, its dead-letter
    operations and `ship-realtime.publication.cleanup` as module `ship-realtime`.
  - New diagnostic `SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING` for a write publisher without the
    mounted module or with an unlisted channel; `SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN` now
    applies to `transaction: "read"` publishers only. Generated outbox dispatchers declare channel
    publication tokens under `publishes` rather than `effects`.
  - Graph: every publishing operation node carries `publicationDelivery: "immediate" | "outbox"`.
    Delivery through the outbox is eventual and at-least-once.

- [#133](https://github.com/SixthSummit/ship-api/pull/133) [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add declared streaming responses: `transport.response = { mode: "stream", framing, frame, heartbeatMs, maxDurationMs, maxFrames }`. Handlers receive a validated `stream.emit(frame)` seam and `stream.signal`, `OperationRunOptions.stream` supplies the frame sink for direct execution, the graph projects the declaration, and `compileApp` reports `SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN`, `SHIP_OPERATION_STREAM_LIMIT_MISSING`, `SHIP_OPERATION_STREAM_OUTPUT_INVALID`, and `SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN`.

- [#154](https://github.com/SixthSummit/ship-api/pull/154) [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Dispatchers now claim persisted receipts whose intent ID is no longer declared and dead-letter them for inspection, instead of leaving them pending indefinitely. The Drizzle and in-memory backends implement an atomic unknown-ID claim that respects intent partitions. Custom unpartitioned backends remain compatible through an unfiltered claim; partitioned custom backends must implement `claimUnknownDue`.

- [#142](https://github.com/SixthSummit/ship-api/pull/142) [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare webhook response modes and an HTTP transport for replay (ADR-0018 addendum).

  - `defineWebhook` accepts `response: { mode: "json" } | { mode: "text", contentType } | { mode: "binary", contentType } | { mode: "empty" }` (default `json`, unchanged). Text and binary handlers return the body or `respond(status, body)`; `empty` handlers return nothing and the adapter answers the declared success status with no body and no content type. `SHIP_WEBHOOK_RESPONSE_INVALID` rejects a text/binary mode without `contentType`, a consumer `output` for framework-owned modes, and non-JSON modes on enqueue webhooks. `emptySchema()` and `isWebhookTransport()` are exported. A `cache` declaration on `defineWebhook` or `defineWebhookReplay` is rejected with `SHIP_WEBHOOK_CACHE_FORBIDDEN`; webhooks never take the stream mode.
  - `defineWebhookReplay` accepts `transport: { path }` or a JSON `http.post(...)` transport; a `:eventId` path parameter or the JSON body carries the event id and access stays permission-gated (`SHIP_WEBHOOK_TRANSPORT_INVALID` for anything else).
  - `@sixthsummit/ship-hono`: `serializeSuccess` settles the representation from the declared transport before merging `respond({ headers })`, honors a webhook's declared text/binary content type, and answers `empty` bodiless. HTTP operations are unchanged; `content-type` stays reserved. `HttpResponseMode` gains the webhook-only `"empty"` member.
  - `@sixthsummit/ship-contract`: `x-ship-webhook` carries `response`; OpenAPI documents text/binary acknowledgements under their content type and empty ones without content; a mounted replay is projected as an ordinary permission-gated operation. Webhooks remain excluded from the browser manifest.
  - `@sixthsummit/ship-webhooks`: documents the Twilio TwiML and status-callback modes.

### Patch Changes

- [#175](https://github.com/SixthSummit/ship-api/pull/175) [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep `ActorResolution` as the 1.0 contract: a successful resolution's `actor` is always an `OperationActor` with a `kind`. The previous change widened it to accept kind-less actors, which broke code that passes `resolver.resolve(...)`'s actor on as an `OperationActor` (TS2322).

  Resolver authors still get the leniency: `defineActorResolver()` now takes an `ActorResolverDefinition`, whose `resolve` may return an `ActorResolutionResult` with a ship-core 1.0 actor, and the returned resolver normalises every result (missing `kind` becomes `human`) before any caller sees it. An invalid result is still passed through for the request boundary to reject. `isActorResolution()` now guards `ActorResolutionResult`; `NormalizedActorResolution` is a deprecated alias of `ActorResolution`.

- [#161](https://github.com/SixthSummit/ship-api/pull/161) [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Persist an explicit JSON-safe marker for undefined idempotent success bodies and replay older empty webhook receipts whose JSONB result omitted `data`. Duplicate empty webhook deliveries now retain their bodiless success response.

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep actors without `kind` working within 1.x, so authenticated requests no longer fail with 500 when an older adapter is in the tree.

  An actor built on ship-core 1.0 has no `kind`. ship-auth-firebase 1.0 rebuilds the actor its `resolveActor` returns with its own ship-core copy, which npm nests next to a prerelease ship-core 1.1, so the HTTP adapter received a kind-less actor, rejected the resolution as "an invalid result" and answered 500 (including where the right answer was 403).

  - `@sixthsummit/ship-core`: new `normalizeActorResolution()` and `normalizeOperationActor()` fill in `kind: "human"` for a kind-less actor before validating it, and `isActorResolution()` accepts such resolutions. A kind-less actor can never carry `provider` or `onBehalfOf`, so it can't claim system or provider status. `executor.run()` normalises its `actor` option the same way. Resolver results and `executor.run()` take the new `OperationActorInput` type (`OperationActor | LegacyOperationActor`), so 1.0-typed resolvers compile again. `OperationActor`, which handlers see, still always has `kind`.
  - `@sixthsummit/ship-hono` and `@sixthsummit/ship-realtime-socketio`: normalise the resolver result, then validate it. Permission and actor-kind denials stay 403.
  - `@sixthsummit/ship-auth-firebase`: released alongside, so it depends on ship-core and ship-hono 1.1 and no longer pulls in nested 1.0 copies. `resolveActor` may return a kind-less actor.
  - `@sixthsummit/ship-api`: re-exports the new helpers and types.

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept lowercase dot-namespaced permission slugs as well as colon-namespaced
  slugs so applications can preserve established RBAC catalogs during migration.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the transport- and infrastructure-independent operation kernel as `@sixthsummit/ship-core`. Keep the former `@sixthsummit/ship-api/kernel` path as a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Type authenticated and permission-gated operation handler contexts with a
  required actor, matching the executor's existing access-before-handler runtime
  guarantee. Public handlers continue to receive an optional actor.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Match Standard Schema's explicit optional-property types so Zod declarations
  remain assignable in consumers that enable `exactOptionalPropertyTypes`.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept lowercase dot-namespaced permission slugs as well as colon-namespaced
  slugs so applications can preserve established RBAC catalogs during migration.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the transport- and infrastructure-independent operation kernel as `@sixthsummit/ship-core`. Keep the former `@sixthsummit/ship-api/kernel` path as a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Type authenticated and permission-gated operation handler contexts with a
  required actor, matching the executor's existing access-before-handler runtime
  guarantee. Public handlers continue to receive an optional actor.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Match Standard Schema's explicit optional-property types so Zod declarations
  remain assignable in consumers that enable `exactOptionalPropertyTypes`.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.
