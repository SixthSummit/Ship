# @sixthsummit/ship-drizzle

## 1.3.0

### Minor Changes

- b612767: Add the transactional mail send ledger: `shipMailSendsTable()` (`ship_mail_sends`, one row per idempotency key with addressed and delivered recipients, status, attempts, provider ids and timestamps; GIN-indexed recipients) and `createDrizzleMailLedger()` implementing the kernel `MailLedger` contract with an atomic claim that retakes failed rows and stale claims.
- b350b5d: Managed storage support (ADR-0022). `@sixthsummit/ship-drizzle` adds `shipStorageIntentsTable()`, `shipStorageObjectsTable()`, `shipStoragePurgesTable()` and `createDrizzleAttachmentLedger()`, whose claims use `FOR UPDATE SKIP LOCKED` and whose `attach`/`detach` join the executor's unit-of-work scope; include the tables in application migrations as a release step. `@sixthsummit/ship-testing` adds `createInMemoryStorageAdapter()`, `createInMemoryAttachmentLedger()` and the runner-agnostic `storageAdapterConformance()` suite under the `./storage` subpath.
- 5e2858d: Implement the kernel's operator introspection for the ops console (SAPI-757): the in-memory job, webhook-event, outbox and realtime backends; the BullMQ backend (`getJobs`, job scheduler `next`, `queue.pause`/`resume`); the PostgreSQL job backend (run and schedule queries, durable pause through the new opt-in `shipJobControlTable()` passed as `controlTable`, read once per worker poll), outbox (`findRecord`/`listRecords`) and webhook event store (`list`); and the Socket.IO gateway (per-channel subscriber and scope counts, last publish).
- 3e368c2: Declare the shared runtimes an application also imports as peer dependencies instead of regular
  dependencies, so one copy is resolved: `hono` in `@sixthsummit/ship-hono`, `drizzle-orm` in
  `@sixthsummit/ship-drizzle` and `@sixthsummit/ship-testing`, and `ioredis` in
  `@sixthsummit/ship-jobs-bullmq` and `@sixthsummit/ship-realtime-socketio`. Each package keeps the
  same caret range in its `devDependencies` for its own tests. `socket.io` and `bullmq` stay regular
  dependencies because their adapters create the server, queues and workers themselves; the
  compatibility distribution `@sixthsummit/ship-api` is unchanged. The rule is recorded in
  `docs/VERSIONING.md`.
  
  Consumers that relied on the transitive copy add the runtime to their own `dependencies` with the
  adapter's caret range. `ship-api create` now writes `hono` as the caret range `ship-hono` declares
  as its peer next to exact Ship pins, so a caret bump of the Ship packages can never leave an exact
  `hono` pin behind, and the packed-consumer gate fails when a clean install of the scaffold or of a
  golden consumer resolves more than one `hono` or `drizzle-orm`.

### Patch Changes

- 63eef39: Require `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections) and resolve `body-parser` to `2.4.0` under the MCP server's Express dependency (GHSA-27r3-jxmh-p828). No API change; the Angular library now runs its own suite against zod 4 and the Angular scaffold template asks for `zod ^4.6.7`.

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
- cd52ad0: Move to the OpenTelemetry JS 3.x SDK line: `@opentelemetry/api` `^1.10.0`, `core` /
  `resources` / `sdk-metrics` `^3.0.0`, `sdk-node` / `exporter-prometheus` `^0.300.0`,
  `auto-instrumentations-node` `^0.82.0`. Every package that declares the api now requires
  1.10, which the 3.x SDK packages demand as a peer, so a fresh install under strict peer
  dependencies resolves cleanly. `@opentelemetry/core` is a regular dependency of
  `ship-api` and `ship-observability-otel` so `auto-instrumentations-node`'s peer resolves
  inside the framework rather than at the application root.
  
  `startMetricsServer` keeps listening on all interfaces by default: the 0.300 Prometheus
  exporter binds to `localhost` when no host is given, so the framework now passes
  `0.0.0.0` explicitly unless `host` or `METRICS_HOST` is set. `MetricsServerHandle.host`
  is therefore always a string. The exporter no longer reads
  `OTEL_EXPORTER_PROMETHEUS_HOST` / `_PORT`; use `METRICS_HOST` / `METRICS_PORT`.
  
  Applications that construct tracer providers directly should import `TracerProvider`
  from `@opentelemetry/sdk-trace` (the `sdk-trace-base` / `sdk-trace-node` packages are
  retired) and pass span processors an options object, e.g.
  `new SimpleSpanProcessor({ exporter })`. The 3.x SDK requires Node.js 22.15 or newer.

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

## 1.1.0

### Minor Changes

- [#132](https://github.com/SixthSummit/ship-api/pull/132) [`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit actor kinds, a durable transactional outbox, and executor-enforced idempotency (ADR-0014).

  - `OperationActor` now carries `kind` (`human` | `system` | `provider`); `systemActor()`, `providerActor()`, `systemAccess()` and `providerAccess(id)` are new. Every actor a handler sees has `kind`. An actor without `kind` (built on ship-core 1.0) is still accepted by resolvers and `executor.run()` and normalised to `human`; `isOperationActor()` checks the normalised shape. Build actors with `operationActor()` (defaults to `human`).
  - `defineOutbox`, `outboxIntent`, `outboxDependency`, `defineOutboxDispatcher`, `defineOutboxCleanup` and the `OutboxBackend` contract deliver intents at-least-once with leases, bounded retry, dead-lettering and retention.
  - `idempotency: { key, windowMs, store }` on `defineOperation` replays stored results, reports `IDEMPOTENT_IN_FLIGHT` (409), and releases claims on failure.
  - `@sixthsummit/ship-drizzle`: `createDrizzleOutbox`, `shipOutboxTable`, `createDrizzleIdempotencyStore`, `shipIdempotencyTable`, `transactionForScope`.
  - `@sixthsummit/ship-testing`: `createInMemoryOutbox`, `createInMemoryIdempotencyStore`, `drainOutbox`.
  - `@sixthsummit/ship-contract`: projects `system`/`provider` access, idempotency windows and the `IDEMPOTENT_IN_FLIGHT` failure.

- [#143](https://github.com/SixthSummit/ship-api/pull/143) [`8c9a40b`](https://github.com/SixthSummit/ship-api/commit/8c9a40baa2404e5dcdaa80d72709f8f31523e1cc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `createDrizzleJobBackend`, `shipJobRunsTable` and `shipJobStateTable`: a PostgreSQL `JobBackend` for consumers without Redis. Runs are claimed with `FOR UPDATE SKIP LOCKED`, leased and heartbeated with a fencing token (`SHIP_DRIZZLE_JOB_LEASE_STALE` when a stale holder's outcome is rejected), deduplicated by `dedupeKey`, bounded by `queue-full`, retried with backoff, dead-lettered with input and history, and swept by retention; schedules are reconciled per job and ticked with durable run ids across processes. `backend.lockProvider` defaults to `advisoryLockProvider(database)`; metrics reuse the `ship.job.*` names. Also exports `createDrizzleJobMetrics` and `nextOccurrence`.

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `advisoryLockProvider(database)`, a PostgreSQL advisory-lock `LockProvider` for single-runner jobs.

- [#138](https://github.com/SixthSummit/ship-api/pull/138) [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add inbound webhook operations (ADR-0018).

  - `@sixthsummit/ship-core`: `defineWebhook` compiles a bounded raw-body POST operation with `providerAccess`, a pure `WebhookVerifier` contract with explicit guarantees, rotatable `WebhookSecretSource`s, executor-enforced idempotency with a declared in-flight policy, inline or enqueue (receive-then-process) modes, `webhookIntent`, `defineWebhookReplay`, `defineWebhookCleanup`, the `WebhookEventStore` contract, a `WebhookObserver` hook, and edge-safe WebCrypto helpers. The executor reports `SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE` for store outages and marks replayed results with `replayed: true`.
  - `@sixthsummit/ship-hono`: `createHonoAdapter({ webhooks: { publicBaseUrl, observer } })` verifies exact bytes before any actor exists, derives canonical URLs from the declared base URL, and maps outcomes to stable `WEBHOOK_*` responses.
  - `@sixthsummit/ship-drizzle`: `shipWebhookEventsTable` and `createDrizzleWebhookEventStore` with retention cleanup that never deletes undispatched events.
  - `@sixthsummit/ship-testing`: `createInMemoryWebhookEventStore`, `fakeWebhookProvider`, and `purgeExpired` on the in-memory idempotency store.
  - `@sixthsummit/ship-contract`: webhook operations are excluded from the browser manifest and documented in OpenAPI under `x-ship-webhook`.
  - `@sixthsummit/ship-observability-otel`: `createWebhookMetrics` records receive outcomes, verification failures, duplicates and receive-to-dispatch lag.
  - `@sixthsummit/ship-webhooks` (new, `0.1.0-alpha.0`): subpath verifiers for Stripe, GitHub, Slack, Twilio, Resend, HighLevel and a documented shared-secret fallback.

- [#154](https://github.com/SixthSummit/ship-api/pull/154) [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Dispatchers now claim persisted receipts whose intent ID is no longer declared and dead-letter them for inspection, instead of leaving them pending indefinitely. The Drizzle and in-memory backends implement an atomic unknown-ID claim that respects intent partitions. Custom unpartitioned backends remain compatible through an unfiltered claim; partitioned custom backends must implement `claimUnknownDue`.

### Patch Changes

- [#149](https://github.com/SixthSummit/ship-api/pull/149) [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the two outbox findings of the M10 capacity baseline (SAPI-114, ADR-0014 and ADR-0017 addenda).

  - `@sixthsummit/ship-drizzle`: `shipOutboxTable()` adds the partial indexes `<table>_pending_idx` (`outbox_id, available_at, created_at` where `status = 'pending'`) and `<table>_lease_idx` (`outbox_id, lease_expires_at` where `status = 'claimed'`); generate a migration. `claimDue` retakes lease-expired rows first and fills the batch from pending rows through two ordered index scans with `FOR UPDATE SKIP LOCKED` instead of one `OR` that sorted every due row, so a 25-row claim costs about 5 ms at 200k pending rows instead of 71 ms.
  - `@sixthsummit/ship-core`: `startOutboxDispatchRunner(executor, "<outbox>.dispatch", { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError?, actor?, signal? })` is the adaptive dispatch loop (a full batch is followed by the next pass at once, bounded by `maxPassesPerCycle`; a short or empty batch waits the interval; failures back off; `runOnce()`; graceful `stop()`), with `dispatchOutbox` as the single pass, `OutboxRunnerError` (`SHIP_OUTBOX_RUNNER_INVALID`, `SHIP_OUTBOX_DISPATCH_FAILED`), `OUTBOX_RUNNER_ACTOR_ID` and the `DEFAULT_OUTBOX_RUNNER_*` constants. `startRealtimePublicationRunner` is that loop over the publication dispatcher; its pass and observer types are aliases of `OutboxDispatchRunnerPass` and `OutboxDispatchRunnerObserver`, and a short (non-empty) pass now waits the interval instead of passing again at once.
  - `OutboxDispatchResult` carries `batchSize`; the dispatcher's `describeOutboxOperation` role carries `batchSize` and an optional `roundsPerSecond`.
  - `defineOutbox({ expectedRatePerSecond? })` and `defineOutboxDispatcher(outbox, { roundsPerSecond? })` (also accepted by `defineRealtimePublicationOutbox`, `defineRealtimePublicationDispatcher` and `defineRealtimePublicationModule`) are optional; when both are declared the compiler warns `SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE` if `batchSize x roundsPerSecond` is below the rate, and the outbox graph node projects `expectedRatePerSecond` and `dispatchCapacityPerSecond`. `SHIP_OUTBOX_EXPECTED_RATE_INVALID` rejects a non-positive rate.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish transaction execution, repository primitives, named projections, and tenant-scoped repository factories as `@sixthsummit/ship-drizzle`. The monolithic Drizzle entry becomes a deprecated compatibility re-export.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@1.0.0

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish transaction execution, repository primitives, named projections, and tenant-scoped repository factories as `@sixthsummit/ship-drizzle`. The monolithic Drizzle entry becomes a deprecated compatibility re-export.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Snapshot authorized tenant and actor evidence before asynchronous policy evaluation. Reject singleton providers that capture operation-scoped dependencies and check cancellation after asynchronous output validation so cancelled transactions roll back.

  Reject dot-only client path parameters, preserve bodyless HTTP 205 results through contracts and adapters, and reject detached work that attempts to reuse a completed Drizzle transaction scope.

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@0.1.0-alpha.1
