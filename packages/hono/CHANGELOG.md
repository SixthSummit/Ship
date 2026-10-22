# @sixthsummit/ship-hono

## 1.2.1

### Patch Changes

- c049215: Require the October 2026 Node.js security releases (22.23.4, 24.22.1, 26.12.1 or newer),
  which fix the Brotli decoder remote code execution (CVE-2026-111497), TLS hostname
  verification bypasses, and `dns.resolve` truncation. Bump `hono` to 4.13.13 to pick up
  the `serveStatic` double-decode middleware bypass fix (GHSA-5r4p-p66f-jhc7).
  
  Keep OpenTelemetry on the 2.x SDK line while the ecosystem moves to api 1.10 / SDK 3.0.
  OpenTelemetry JS published `@opentelemetry/api` 1.10.0 alongside a new SDK major (core 3.0.0 /
  sdk-node 0.300.0); every 2.x SDK package rejects api 1.10.0 as a peer. Three changes keep a
  fresh consumer install resolving api 1.9.x:
  
  - `@opentelemetry/api` is constrained to `>=1.9.1 <1.10.0` wherever it is declared.
  - `@opentelemetry/core` is now a regular dependency of ship-api and ship-observability-otel,
    so auto-instrumentations-node's peer on it resolves inside those packages instead of
    bubbling to the consumer root.
  - ship-testing and ship-auth-firebase declare the bounded `@opentelemetry/api` too. Neither
    imports it directly, but drizzle-orm (testing) and Firestore via firebase-admin
    (auth-firebase) request api with open ranges; without a bound in those subtrees pnpm
    resolves 1.10.0 first and then reuses it for later peer contexts, depending on the order
    dependencies appear in the consumer manifest.
  
  Moving to the OpenTelemetry 3.x line is a separate upgrade.

## 1.2.0

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
- 6cac2d2: Require patched Hono releases and prepare public npm distribution under the existing package names.

## 1.1.0

### Minor Changes

- [#169](https://github.com/SixthSummit/ship-api/pull/169) [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add optional bounded result observation to durable job backends and a synchronous HTTP job projection. BullMQ retains completed results and final failures while a timed-out HTTP request returns the durable run ID for reconciliation without cancelling the job. A delivery dedupe key can reuse a retained terminal run, preventing a scheduler retry from replaying the effect.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an HTTP operation to explicitly treat malformed JSON as absent input or reject an empty JSON request body after authentication, while preserving strict parsing by default. Include both policies in projected client contracts.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an operation to explicitly ignore non-JSON request bodies while retaining bounded JSON parsing. This supports legacy routes that treated those bodies as absent input; the default remains a 415 rejection.

- [#160](https://github.com/SixthSummit/ship-api/pull/160) [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow declared operation failures to carry safe, required response headers such as `Retry-After`, and project those declarations through Hono, client contracts, and OpenAPI.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Support declared, bodyless HTTP redirects with validated Location headers, truthful OpenAPI responses, and explicit manual Fetch behavior for opaque browser redirects.

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `httpJobTrigger` for http-triggered jobs plus `bearerTokenCredentials`, `jobTriggerActorResolver` and `jobTriggerPermission` for scheduler identity tokens and scoped bearer secrets.

- [#135](https://github.com/SixthSummit/ship-api/pull/135) [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a declared read cache with framework-owned keys and durable tag invalidation (ADR-0019).

  - `defineOperation` accepts `cache: { ttlMs, scope: "actor" | "tenant" | "public", vary?, tags?, tenant? }` on `transaction: "none"` and `"read"` operations. The executor derives every key from the operation id, its graph version, the actor id or the identifier of an authentic `TenantScope`, the canonical validated input and `vary` — a consumer cannot supply a raw key. Hits replay the stored success and are marked `cache: "hit"`; declared failures are never cached; concurrent misses for one key are coalesced. Streaming operations bypass the read cache: `cache` on a `transport.response.mode: "stream"` operation fails compilation with `SHIP_OPERATION_STREAM_CACHE_FORBIDDEN`.
  - `invalidates: readonly string[]` on `transaction: "write"` operations records one durable purge intent per tag through the framework-owned `ship-cache.invalidation` outbox inside the write transaction, so a rollback leaves none. Mount `defineCacheInvalidationModule({ cache, outbox })` once; the generated dispatcher performs the purge after commit. Invalidation is eventual.
  - `CacheBackend` (`get`, `set`, `del`, `delByTag`, `health`, optional `singleFlight`) is bound with `cacheBackendDependency(id)`. New diagnostics: `SHIP_CACHE_TRANSACTION_FORBIDDEN`, `SHIP_CACHE_BACKEND_UNBOUND`, `SHIP_CACHE_SCOPE_ACTOR_INVALID`, `SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID`, `SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING`, `SHIP_CACHE_PROVIDER_LIFETIME_INVALID`, and the `SHIP_CACHE_TAG_UNKNOWN` warning carried in `graph.diagnostics`.
  - `@sixthsummit/ship-cache-redis` (new): `createRedisCacheBackend` stores JSON with millisecond TTLs and TTL-matched Redis tag sets, driver-free through a small `RedisLike` client interface.
  - `@sixthsummit/ship-testing`: `createInMemoryCacheBackend` and the runner-agnostic `cacheBackendConformance` suite both adapters pass.
  - `@sixthsummit/ship-hono`: cached responses carry `x-ship-cache: hit|miss` (a reserved header) and the declared `Cache-Control`.
  - `@sixthsummit/ship-contract`: the client contract and OpenAPI carry cache policy, `Cache-Control` and `X-Ship-Cache`.
  - `@sixthsummit/ship-cli`: `inspect` prints cache policy and invalidated tags, `affected` follows tag edges from a write to the cached reads it purges, and `check` reports compilation warnings.

- [#163](https://github.com/SixthSummit/ship-api/pull/163) [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow an HTTP operation to declare first-value query parsing for legacy scalar query contracts. Preserve strict query parsing by default and project the explicit policy into the client contract and OpenAPI.

- [#165](https://github.com/SixthSummit/ship-api/pull/165) [`24d78b0`](https://github.com/SixthSummit/ship-api/commit/24d78b0dfcffa4964d16bb9a2616e5885485b5e3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow a Hono adapter to select `application/json` for JSON failures when a consumer's existing HTTP contract omits the charset parameter. The default remains `application/json; charset=UTF-8`; the option applies to ordinary operations and webhooks without changing status, body, or declared failure headers.

- [#138](https://github.com/SixthSummit/ship-api/pull/138) [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add inbound webhook operations (ADR-0018).

  - `@sixthsummit/ship-core`: `defineWebhook` compiles a bounded raw-body POST operation with `providerAccess`, a pure `WebhookVerifier` contract with explicit guarantees, rotatable `WebhookSecretSource`s, executor-enforced idempotency with a declared in-flight policy, inline or enqueue (receive-then-process) modes, `webhookIntent`, `defineWebhookReplay`, `defineWebhookCleanup`, the `WebhookEventStore` contract, a `WebhookObserver` hook, and edge-safe WebCrypto helpers. The executor reports `SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE` for store outages and marks replayed results with `replayed: true`.
  - `@sixthsummit/ship-hono`: `createHonoAdapter({ webhooks: { publicBaseUrl, observer } })` verifies exact bytes before any actor exists, derives canonical URLs from the declared base URL, and maps outcomes to stable `WEBHOOK_*` responses.
  - `@sixthsummit/ship-drizzle`: `shipWebhookEventsTable` and `createDrizzleWebhookEventStore` with retention cleanup that never deletes undispatched events.
  - `@sixthsummit/ship-testing`: `createInMemoryWebhookEventStore`, `fakeWebhookProvider`, and `purgeExpired` on the in-memory idempotency store.
  - `@sixthsummit/ship-contract`: webhook operations are excluded from the browser manifest and documented in OpenAPI under `x-ship-webhook`.
  - `@sixthsummit/ship-observability-otel`: `createWebhookMetrics` records receive outcomes, verification failures, duplicates and receive-to-dispatch lag.
  - `@sixthsummit/ship-webhooks` (new, `0.1.0-alpha.0`): subpath verifiers for Stripe, GitHub, Slack, Twilio, Resend, HighLevel and a documented shared-secret fallback.

- [#159](https://github.com/SixthSummit/ship-api/pull/159) [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Allow one binary HTTP operation to declare multiple success content types. The adapter requires the handler to select a declared type for each response, and contract clients and OpenAPI expose and validate all declared representations. Generated client types now correctly expose binary response data as `Uint8Array`.

- [#166](https://github.com/SixthSummit/ship-api/pull/166) [`ff6dc11`](https://github.com/SixthSummit/ship-api/commit/ff6dc11675478ed7abb8080dad1a8009267722f7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add operation-scoped authenticated pre-validation HTTP policies with declared failures and safe response headers, pass operation IDs to centralized failure projection, and support literal repeated query-key parsing for compatibility routes.

- [#144](https://github.com/SixthSummit/ship-api/pull/144) [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve declared caching and jobs conformance (ADR-0019 and ADR-0015 addenda).

  - `Cache-Control` projects `public` only when the operation's access is `publicAccess()`; a `scope: "public"` read behind any other access projects `private, max-age=N` everywhere (`ship-hono`, graph, contract, OpenAPI). `cacheControlHeader(cache, access?)` takes the access; omitted, it projects private. New diagnostics: `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (warning), `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (error, optional-identity access).
  - `invalidates` accepts `{ tag, scope: "actor" }` and `{ tag, scope: "tenant", tenant }` beside plain tags. Actor- and tenant-scoped reads store entries under `scopedCacheTag(tag, scopeKey)` as well as the plain tag; a scoped write records `{ tag, scope }` and the dispatcher purges only that subject's entries. Compiled `operation.invalidates` becomes `{ tag, scope, tenant? }[]`; the graph adds `invalidatesScoped`. New diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error), `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). Executor: `SHIP_OPERATION_CACHE_ACTOR_INVALID`.
  - `cache.vary(input, subject)` receives a read-only `{ actor, context }`; `SHIP_CACHE_VARY_SUBJECT_PUBLIC` warns when a public read's `vary` reads it.
  - `defineCacheInvalidationModule({ backend })` binds and exports the `cacheBackendDependency` token so modules with cached reads import `ship-cache` and bind nothing.
  - `@sixthsummit/ship-testing`: `cacheBackendConformance` proves scoped tags stay independent; `@sixthsummit/ship-cache-redis` passes it and the executor-level tenant/actor isolation test against real Redis.
  - `@sixthsummit/ship-cli`: `inspect app|module` lists declared and framework-introduced permissions (`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`); `inspect operation` renders scoped invalidations.
  - Jobs: `defineJob` accepts `retention.completedMs: 0` / `deadLetteredMs: 0` (collect on the next sweep); `startJobRuntime` returns `liveness(now?)` with per-job `lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`completed`/`failed`/`lagMs`; `ship-hono` adds `jobLivenessRoute({ runtime, staleAfterMs?, path? })` and `projectJobLiveness`; `SHIP_MODULE_OPERATION_ID_MISMATCH` explains the job-id and `defineJobManagement` prefix rule.

- [#157](https://github.com/SixthSummit/ship-api/pull/157) [`bb00927`](https://github.com/SixthSummit/ship-api/commit/bb00927fae0aa18bf3b0d8d1e1c91ee1b35c24dc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an opt-in per-adapter failure body projection for compatibility migrations while preserving framework-owned status, headers, and the default error envelope.

- [#133](https://github.com/SixthSummit/ship-api/pull/133) [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the `stream` HTTP response mode (`http.post(path, { response: { mode: "stream", framing: "sse", ... } })`). The adapter serves `200 text/event-stream` with `X-Ship-Stream: sse/1`, applies reader backpressure to `emit`, writes `: hb <unix-ms>` heartbeats while idle, enforces `maxDurationMs`/`maxFrames` with `STREAM_MAX_DURATION_EXCEEDED`/`STREAM_MAX_FRAMES_EXCEEDED` terminal error frames, aborts the handler signal on client disconnect, and keeps the unary JSON error envelope for failures before the first frame. `encodeSseEvent`, `encodeSseHeartbeat`, and `STREAM_ERROR_CODES` are exported.

- [#142](https://github.com/SixthSummit/ship-api/pull/142) [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare webhook response modes and an HTTP transport for replay (ADR-0018 addendum).

  - `defineWebhook` accepts `response: { mode: "json" } | { mode: "text", contentType } | { mode: "binary", contentType } | { mode: "empty" }` (default `json`, unchanged). Text and binary handlers return the body or `respond(status, body)`; `empty` handlers return nothing and the adapter answers the declared success status with no body and no content type. `SHIP_WEBHOOK_RESPONSE_INVALID` rejects a text/binary mode without `contentType`, a consumer `output` for framework-owned modes, and non-JSON modes on enqueue webhooks. `emptySchema()` and `isWebhookTransport()` are exported. A `cache` declaration on `defineWebhook` or `defineWebhookReplay` is rejected with `SHIP_WEBHOOK_CACHE_FORBIDDEN`; webhooks never take the stream mode.
  - `defineWebhookReplay` accepts `transport: { path }` or a JSON `http.post(...)` transport; a `:eventId` path parameter or the JSON body carries the event id and access stays permission-gated (`SHIP_WEBHOOK_TRANSPORT_INVALID` for anything else).
  - `@sixthsummit/ship-hono`: `serializeSuccess` settles the representation from the declared transport before merging `respond({ headers })`, honors a webhook's declared text/binary content type, and answers `empty` bodiless. HTTP operations are unchanged; `content-type` stays reserved. `HttpResponseMode` gains the webhook-only `"empty"` member.
  - `@sixthsummit/ship-contract`: `x-ship-webhook` carries `response`; OpenAPI documents text/binary acknowledgements under their content type and empty ones without content; a mounted replay is projected as an ordinary permission-gated operation. Webhooks remain excluded from the browser manifest.
  - `@sixthsummit/ship-webhooks`: documents the Twilio TwiML and status-callback modes.

### Patch Changes

- [#168](https://github.com/SixthSummit/ship-api/pull/168) [`491d017`](https://github.com/SixthSummit/ship-api/commit/491d01749cfb7cee49be7302ed90f63eb8e36d6a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Pass the matched operation ID to centralized failure projection for authentication and access failures, allowing operation-specific compatibility envelopes without route-local response rewriting.

- [#151](https://github.com/SixthSummit/ship-api/pull/151) [`f38e572`](https://github.com/SixthSummit/ship-api/commit/f38e57225815489a274582e9b930c3c96480d496) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - A request whose client disconnects before the operation finishes now answers with a bodiless `499` and is no longer reported to `onUnexpectedError` or serialized as a `500 INTERNAL_SERVER_ERROR`. The operation is still cancelled through the request signal as before; only the classification and logging changed.

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep actors without `kind` working within 1.x, so authenticated requests no longer fail with 500 when an older adapter is in the tree.

  An actor built on ship-core 1.0 has no `kind`. ship-auth-firebase 1.0 rebuilds the actor its `resolveActor` returns with its own ship-core copy, which npm nests next to a prerelease ship-core 1.1, so the HTTP adapter received a kind-less actor, rejected the resolution as "an invalid result" and answered 500 (including where the right answer was 403).

  - `@sixthsummit/ship-core`: new `normalizeActorResolution()` and `normalizeOperationActor()` fill in `kind: "human"` for a kind-less actor before validating it, and `isActorResolution()` accepts such resolutions. A kind-less actor can never carry `provider` or `onBehalfOf`, so it can't claim system or provider status. `executor.run()` normalises its `actor` option the same way. Resolver results and `executor.run()` take the new `OperationActorInput` type (`OperationActor | LegacyOperationActor`), so 1.0-typed resolvers compile again. `OperationActor`, which handlers see, still always has `kind`.
  - `@sixthsummit/ship-hono` and `@sixthsummit/ship-realtime-socketio`: normalise the resolver result, then validate it. Permission and actor-kind denials stay 403.
  - `@sixthsummit/ship-auth-firebase`: released alongside, so it depends on ship-core and ship-hono 1.1 and no longer pulls in nested 1.0 copies. `resolveActor` may return a kind-less actor.
  - `@sixthsummit/ship-api`: re-exports the new helpers and types.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the Hono transport, credential extraction, and HTTP error projection as `@sixthsummit/ship-hono`. Keep the former `@sixthsummit/ship-api/hono` entry as a deprecated compatibility re-export, with the legacy v4 auth-provider bridge confined to the monolithic package.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@1.0.0

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the Hono transport, credential extraction, and HTTP error projection as `@sixthsummit/ship-hono`. Keep the former `@sixthsummit/ship-api/hono` entry as a deprecated compatibility re-export, with the legacy v4 auth-provider bridge confined to the monolithic package.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@0.1.0-alpha.1
