# @sixthsummit/ship-drizzle

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
