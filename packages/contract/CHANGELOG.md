# @sixthsummit/ship-contract

## 1.3.0

### Minor Changes

- 8f71663: Declare `@sixthsummit/ship-core` (and, where used, `@sixthsummit/ship-hono`) as peer dependencies instead of regular dependencies, so an app always has exactly one copy of each.

  These packages share ship-core's types, runtime guards and process-wide registries with the app, which only works with a single copy. As regular dependencies, a range that didn't match the app's copy (for example `^1.0.0` next to a `1.1.0-alpha-…` snapshot) made npm silently install a private nested copy. The types and runtime checks then disagreed with the app's copy, and authenticated requests failed with 500. As peers, the package manager uses the app's copy, or fails at install time (npm `ERESOLVE`) when the versions don't fit, instead of duplicating it.

  What changes on install:

  - `ship-hono`, `ship-drizzle`, `ship-cli`, `ship-cache-redis`, `ship-jobs-bullmq`, `ship-observability-otel`, `ship-testing` and `ship-webhooks` peer on `ship-core`.
  - `ship-auth-firebase` and `ship-realtime-socketio` peer on `ship-core` and `ship-hono`.
  - `ship-contract` peers on `ship-core` as an optional peer: the browser-safe entry points (`.`, `./client`, `./manifest`) don't need it, while `./application`, `./project`, `./openapi` and `./schema` use the app's copy.
  - The `@sixthsummit/ship-api` compatibility distribution is unchanged: it still depends on ship-core and ship-hono directly.

  npm 7+ and pnpm install required peers automatically, and every known consumer already lists `@sixthsummit/ship-core` and `@sixthsummit/ship-hono` as direct dependencies, so no manifest change is needed there. An app that installs one of these packages without listing ship-core (or ship-hono) should add it as a direct dependency. With `--legacy-peer-deps` (or npm 6) peers are not installed automatically. A version mismatch that used to be hidden by a nested copy now fails `npm install` with `ERESOLVE`. Align the versions; don't pass `--legacy-peer-deps`.

### Patch Changes

- 8f71663: License the framework under Apache-2.0, include LICENSE and NOTICE in published packages, and update package documentation.

  Remove application-specific documentation and replace client-derived regression fixtures with synthetic framework examples.

## 1.2.0

### Minor Changes

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an HTTP operation to explicitly treat malformed JSON as absent input or reject an empty JSON request body after authentication, while preserving strict parsing by default. Include both policies in projected client contracts.

- [#160](https://github.com/SixthSummit/ship-api/pull/160) [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow declared operation failures to carry safe, required response headers such as `Retry-After`, and project those declarations through Hono, client contracts, and OpenAPI.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Support declared, bodyless HTTP redirects with validated Location headers, truthful OpenAPI responses, and explicit manual Fetch behavior for opaque browser redirects.

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

- [#159](https://github.com/SixthSummit/ship-api/pull/159) [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow one binary HTTP operation to declare multiple success content types. The adapter requires the handler to select a declared type for each response, and contract clients and OpenAPI expose and validate all declared representations. Generated client types now correctly expose binary response data as `Uint8Array`.

- [#144](https://github.com/SixthSummit/ship-api/pull/144) [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve declared caching and jobs conformance (ADR-0019 and ADR-0015 addenda).

  - `Cache-Control` projects `public` only when the operation's access is `publicAccess()`; a `scope: "public"` read behind any other access projects `private, max-age=N` everywhere (`ship-hono`, graph, contract, OpenAPI). `cacheControlHeader(cache, access?)` takes the access; omitted, it projects private. New diagnostics: `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (warning), `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (error, optional-identity access).
  - `invalidates` accepts `{ tag, scope: "actor" }` and `{ tag, scope: "tenant", tenant }` beside plain tags. Actor- and tenant-scoped reads store entries under `scopedCacheTag(tag, scopeKey)` as well as the plain tag; a scoped write records `{ tag, scope }` and the dispatcher purges only that subject's entries. Compiled `operation.invalidates` becomes `{ tag, scope, tenant? }[]`; the graph adds `invalidatesScoped`. New diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error), `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). Executor: `SHIP_OPERATION_CACHE_ACTOR_INVALID`.
  - `cache.vary(input, subject)` receives a read-only `{ actor, context }`; `SHIP_CACHE_VARY_SUBJECT_PUBLIC` warns when a public read's `vary` reads it.
  - `defineCacheInvalidationModule({ backend })` binds and exports the `cacheBackendDependency` token so modules with cached reads import `ship-cache` and bind nothing.
  - `@sixthsummit/ship-testing`: `cacheBackendConformance` proves scoped tags stay independent; `@sixthsummit/ship-cache-redis` passes it and the executor-level tenant/actor isolation test against real Redis.
  - `@sixthsummit/ship-cli`: `inspect app|module` lists declared and framework-introduced permissions (`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`); `inspect operation` renders scoped invalidations.
  - Jobs: `defineJob` accepts `retention.completedMs: 0` / `deadLetteredMs: 0` (collect on the next sweep); `startJobRuntime` returns `liveness(now?)` with per-job `lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`completed`/`failed`/`lagMs`; `ship-hono` adds `jobLivenessRoute({ runtime, staleAfterMs?, path? })` and `projectJobLiveness`; `SHIP_MODULE_OPERATION_ID_MISMATCH` explains the job-id and `defineJobManagement` prefix rule.

- [#137](https://github.com/SixthSummit/ship-api/pull/137) [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project declared realtime channels into the client manifest as
  `channels: { [id]: { scope, payload, presence } }` and `operations[].publishes`,
  with no transport detail; `ClientTypeContract` exposes typed channel payloads and
  `ContractProjectionError` reports `channelId` for channel payload projections.

- [#145](https://github.com/SixthSummit/ship-api/pull/145) [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve realtime and webhook replay conformance (ADR-0017 and ADR-0018 addenda).

  - Presence: `RealtimePresence.actorOnline({ channelId, scopeKey, actorId, ... })` answers cluster-wide whether an actor holds a live subscription; `snapshot` takes `{ cursor?, limit? }` and returns `{ count, actorIds, nextCursor? }` (default page 100, clamped to 1,000; `page-invalid` for malformed paging). `pagePresenceMembers`, `REALTIME_PRESENCE_DEFAULT_LIMIT` and `REALTIME_PRESENCE_MAX_LIMIT` are exported; the in-memory backend and the Socket.IO adapter share them and the conformance suite asserts both. Wire: `ship:presence.snapshot` gains `cursor`/`limit`/`nextCursor` and `INVALID_PAGE`; `ship:presence.online` is new.
  - Publishers: `createChannelPublisherRegistry(channels | { modules }, backend)` derives `get`/`has`/`for`/`publish` and `providers` from the declarations; `defineRealtimePublicationModule` exposes its registry as `publishers`. `AnyChannelPublisher`, `isChannelPublisher` and `narrowChannelPublisher` give generic bridges an erased, runtime-validated publish and a typed way back.
  - Executor: `ApplicationExecutor.tryRun()` returns `OperationExecutionFailure` (the HTTP adapter's 500 envelope plus `cause`) where `run()` throws an `OperationExecutionError`; `operationExecutionFailure()` builds the envelope. `run()` is unchanged.
  - Dispatch: `dispatchRealtimePublications(executor)` is the one dispatch pass; `startRealtimePublicationRunner(executor, { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError? })` loops it with bounded bursts, failure backoff, `runOnce()` and graceful `stop()`; `defineRealtimePublicationDispatchJob({ trigger, executor })` runs it as a declared single-runner job. `@sixthsummit/ship-realtime-socketio` adds `createPublicationRunnerMetrics()` (`ship.realtime.publication.runs`, `.run.duration`, `.records`). New `RealtimeError` codes `SHIP_REALTIME_DISPATCH_FAILED` and `SHIP_REALTIME_RUNNER_INVALID`.
  - Manifest projection: `ProjectableRuntimeSchema`, `CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS`, `hasContractProjection` and `isManifestProjectable` name the convention; compilation warns `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE`; `ChannelGraphNode.payload` gains `projectable`; `defineModule` keeps `channels` typed per module (an omitted list is the empty tuple); `ApplicationContractOf` gains `channels` with `ChannelPayloadOf` and `ChannelPayloadNotProjectable<id>`.
  - Webhook replay: `defineWebhookReplay` accepts any single `:name` path parameter as the event id (`WebhookReplayPathParameter<TPath>`, params keyed by the name) with an optional `transport.eventIdParameter` cross-check; the JSON body fallback is unchanged.

- [#133](https://github.com/SixthSummit/ship-api/pull/133) [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project streaming operations into the client manifest as `response: { mode: "stream", framing: "sse", frame, terminal, limits }` (fingerprinted) and into OpenAPI as a `text/event-stream` response with `x-ship-stream-*` extensions. `client.call()` now returns a synchronous, browser-safe `OperationStreamHandle` (`frames`, `terminal`, `abort`, `status`, `error`) for those operations; `createSseParser()` and `STREAM_INTERRUPTED` are exported.

- [#142](https://github.com/SixthSummit/ship-api/pull/142) [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare webhook response modes and an HTTP transport for replay (ADR-0018 addendum).

  - `defineWebhook` accepts `response: { mode: "json" } | { mode: "text", contentType } | { mode: "binary", contentType } | { mode: "empty" }` (default `json`, unchanged). Text and binary handlers return the body or `respond(status, body)`; `empty` handlers return nothing and the adapter answers the declared success status with no body and no content type. `SHIP_WEBHOOK_RESPONSE_INVALID` rejects a text/binary mode without `contentType`, a consumer `output` for framework-owned modes, and non-JSON modes on enqueue webhooks. `emptySchema()` and `isWebhookTransport()` are exported. A `cache` declaration on `defineWebhook` or `defineWebhookReplay` is rejected with `SHIP_WEBHOOK_CACHE_FORBIDDEN`; webhooks never take the stream mode.
  - `defineWebhookReplay` accepts `transport: { path }` or a JSON `http.post(...)` transport; a `:eventId` path parameter or the JSON body carries the event id and access stays permission-gated (`SHIP_WEBHOOK_TRANSPORT_INVALID` for anything else).
  - `@sixthsummit/ship-hono`: `serializeSuccess` settles the representation from the declared transport before merging `respond({ headers })`, honors a webhook's declared text/binary content type, and answers `empty` bodiless. HTTP operations are unchanged; `content-type` stays reserved. `HttpResponseMode` gains the webhook-only `"empty"` member.
  - `@sixthsummit/ship-contract`: `x-ship-webhook` carries `response`; OpenAPI documents text/binary acknowledgements under their content type and empty ones without content; a mounted replay is projected as an ordinary permission-gated operation. Webhooks remain excluded from the browser manifest.
  - `@sixthsummit/ship-webhooks`: documents the Twilio TwiML and status-callback modes.

### Patch Changes

- [#132](https://github.com/SixthSummit/ship-api/pull/132) [`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit actor kinds, a durable transactional outbox, and executor-enforced idempotency (ADR-0014).

  - `OperationActor` now carries `kind` (`human` | `system` | `provider`); `systemActor()`, `providerActor()`, `systemAccess()` and `providerAccess(id)` are new. Every actor a handler sees has `kind`. An actor without `kind` (built on ship-core 1.0) is still accepted by resolvers and `executor.run()` and normalised to `human`; `isOperationActor()` checks the normalised shape. Build actors with `operationActor()` (defaults to `human`).
  - `defineOutbox`, `outboxIntent`, `outboxDependency`, `defineOutboxDispatcher`, `defineOutboxCleanup` and the `OutboxBackend` contract deliver intents at-least-once with leases, bounded retry, dead-lettering and retention.
  - `idempotency: { key, windowMs, store }` on `defineOperation` replays stored results, reports `IDEMPOTENT_IN_FLIGHT` (409), and releases claims on failure.
  - `@sixthsummit/ship-drizzle`: `createDrizzleOutbox`, `shipOutboxTable`, `createDrizzleIdempotencyStore`, `shipIdempotencyTable`, `transactionForScope`.
  - `@sixthsummit/ship-testing`: `createInMemoryOutbox`, `createInMemoryIdempotencyStore`, `drainOutbox`.
  - `@sixthsummit/ship-contract`: projects `system`/`provider` access, idempotency windows and the `IDEMPOTENT_IN_FLIGHT` failure.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an operation to explicitly ignore non-JSON request bodies while retaining bounded JSON parsing. This supports legacy routes that treated those bodies as absent input; the default remains a 415 rejection.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an HTTP operation to declare first-value query parsing for legacy scalar query contracts. Preserve strict query parsing by default and project the explicit policy into the client contract and OpenAPI.

- [#167](https://github.com/SixthSummit/ship-api/pull/167) [`38e26e3`](https://github.com/SixthSummit/ship-api/commit/38e26e37ad90a5c01f9373d65220a2a4236e5168) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept the Hono `literal-keys` query parsing mode in generated client contracts so consumers can initialize operation clients for compatibility routes.

- [#170](https://github.com/SixthSummit/ship-api/pull/170) [`319f350`](https://github.com/SixthSummit/ship-api/commit/319f350a67e125d354a6edcfb67fd88bb38a3b27) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Type multipart HTTP operation bodies as `FormData` in generated clients, even when their projected JSON Schema describes binary file fields for OpenAPI.

- [#158](https://github.com/SixthSummit/ship-api/pull/158) [`c8d7c9f`](https://github.com/SixthSummit/ship-api/commit/c8d7c9f7e5ce96e4f51c4eeffc63b32234589c9f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep operation input-location checks exact without expanding large generated contracts at client call sites. Export the shared `OperationClientCall` type for adapters and accept non-stream contracts compiled with `exactOptionalPropertyTypes`.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0

## 1.1.0

### Minor Changes

- [#122](https://github.com/SixthSummit/ship-api/pull/122) [`a702f4e`](https://github.com/SixthSummit/ship-api/commit/a702f4eaae0c61398d7b0b96591a3f8010c5224b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `keepalive` to `OperationCallOptions`. When set, `createHttpOperationClient`
  forwards it to fetch's `RequestInit.keepalive` alongside `signal`, so a request
  such as a page-hide heartbeat can outlive navigation. When omitted, no
  `keepalive` key is sent and existing behaviour is unchanged. Browsers cap
  keepalive request bodies at 64 KiB; the client does not enforce that limit.

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project the wire-input side of Zod schemas into generated contracts. Operations
  may now use defaults and transforms to normalize query, path, header, or body
  values for typed handlers without making their browser client contract
  unrepresentable. Output and error schemas remain projected from their output
  side.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the browser-safe operation client, JSON contract manifest, backend application types, schema projection, and OpenAPI projection as `@sixthsummit/ship-contract`. The monolithic contract subpaths become deprecated compatibility re-exports.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@1.0.0

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project the wire-input side of Zod schemas into generated contracts. Operations
  may now use defaults and transforms to normalize query, path, header, or body
  values for typed handlers without making their browser client contract
  unrepresentable. Output and error schemas remain projected from their output
  side.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the browser-safe operation client, JSON contract manifest, backend application types, schema projection, and OpenAPI projection as `@sixthsummit/ship-contract`. The monolithic contract subpaths become deprecated compatibility re-exports.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@0.1.0-alpha.1
