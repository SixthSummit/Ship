# @sixthsummit/ship-realtime-socketio

## 0.3.0

### Minor Changes

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

## 0.2.1

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
- Updated dependencies [c049215]
- Updated dependencies [cd52ad0]
  - @sixthsummit/ship-observability-otel@1.3.0

## 0.2.0

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
- Updated dependencies [8f71663]
- Updated dependencies [8f71663]
  - @sixthsummit/ship-observability-otel@1.2.0

## 0.1.0

### Minor Changes

- [#145](https://github.com/SixthSummit/ship-api/pull/145) [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve realtime and webhook replay conformance (ADR-0017 and ADR-0018 addenda).

  - Presence: `RealtimePresence.actorOnline({ channelId, scopeKey, actorId, ... })` answers cluster-wide whether an actor holds a live subscription; `snapshot` takes `{ cursor?, limit? }` and returns `{ count, actorIds, nextCursor? }` (default page 100, clamped to 1,000; `page-invalid` for malformed paging). `pagePresenceMembers`, `REALTIME_PRESENCE_DEFAULT_LIMIT` and `REALTIME_PRESENCE_MAX_LIMIT` are exported; the in-memory backend and the Socket.IO adapter share them and the conformance suite asserts both. Wire: `ship:presence.snapshot` gains `cursor`/`limit`/`nextCursor` and `INVALID_PAGE`; `ship:presence.online` is new.
  - Publishers: `createChannelPublisherRegistry(channels | { modules }, backend)` derives `get`/`has`/`for`/`publish` and `providers` from the declarations; `defineRealtimePublicationModule` exposes its registry as `publishers`. `AnyChannelPublisher`, `isChannelPublisher` and `narrowChannelPublisher` give generic bridges an erased, runtime-validated publish and a typed way back.
  - Executor: `ApplicationExecutor.tryRun()` returns `OperationExecutionFailure` (the HTTP adapter's 500 envelope plus `cause`) where `run()` throws an `OperationExecutionError`; `operationExecutionFailure()` builds the envelope. `run()` is unchanged.
  - Dispatch: `dispatchRealtimePublications(executor)` is the one dispatch pass; `startRealtimePublicationRunner(executor, { intervalMs?, maxPassesPerCycle?, backoff?, observer?, onError? })` loops it with bounded bursts, failure backoff, `runOnce()` and graceful `stop()`; `defineRealtimePublicationDispatchJob({ trigger, executor })` runs it as a declared single-runner job. `@sixthsummit/ship-realtime-socketio` adds `createPublicationRunnerMetrics()` (`ship.realtime.publication.runs`, `.run.duration`, `.records`). New `RealtimeError` codes `SHIP_REALTIME_DISPATCH_FAILED` and `SHIP_REALTIME_RUNNER_INVALID`.
  - Manifest projection: `ProjectableRuntimeSchema`, `CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS`, `hasContractProjection` and `isManifestProjectable` name the convention; compilation warns `SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE`; `ChannelGraphNode.payload` gains `projectable`; `defineModule` keeps `channels` typed per module (an omitted list is the empty tuple); `ApplicationContractOf` gains `channels` with `ChannelPayloadOf` and `ChannelPayloadNotProjectable<id>`.
  - Webhook replay: `defineWebhookReplay` accepts any single `:name` path parameter as the event id (`WebhookReplayPathParameter<TPath>`, params keyed by the name) with an optional `transport.eventIdParameter` cross-check; the JSON body fallback is unchanged.

- [#137](https://github.com/SixthSummit/ship-api/pull/137) [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Introduce the Socket.IO + Redis realtime gateway adapter: `createRealtimePublisher()`
  for API processes, `createRealtimeGateway()` for gateway processes, handshake
  authentication through the application's credential adapter and actor resolver,
  the v1 wire protocol on the `/ship` namespace, Redis-backed presence with
  dead-gateway sweeping, coalescing, bounded per-connection send buffers with
  drop-oldest/disconnect policies, control-message rate limits, and OpenTelemetry
  metrics carrying `ship.channel.id` and `ship.channel.scope`.

### Patch Changes

- [#162](https://github.com/SixthSummit/ship-api/pull/162) [`5f63bf8`](https://github.com/SixthSummit/ship-api/commit/5f63bf815e3e6c11da1e1973e814f307fb377798) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an optional fail-closed delivery authorization hook that checks each event before it is written to a Socket.IO connection, including queued events.
  Add a fresh, fail-closed subscription admission hook for already-open sockets whose handshake grants may be stale.

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep actors without `kind` working within 1.x, so authenticated requests no longer fail with 500 when an older adapter is in the tree.

  An actor built on ship-core 1.0 has no `kind`. ship-auth-firebase 1.0 rebuilds the actor its `resolveActor` returns with its own ship-core copy, which npm nests next to a prerelease ship-core 1.1, so the HTTP adapter received a kind-less actor, rejected the resolution as "an invalid result" and answered 500 (including where the right answer was 403).

  - `@sixthsummit/ship-core`: new `normalizeActorResolution()` and `normalizeOperationActor()` fill in `kind: "human"` for a kind-less actor before validating it, and `isActorResolution()` accepts such resolutions. A kind-less actor can never carry `provider` or `onBehalfOf`, so it can't claim system or provider status. `executor.run()` normalises its `actor` option the same way. Resolver results and `executor.run()` take the new `OperationActorInput` type (`OperationActor | LegacyOperationActor`), so 1.0-typed resolvers compile again. `OperationActor`, which handlers see, still always has `kind`.
  - `@sixthsummit/ship-hono` and `@sixthsummit/ship-realtime-socketio`: normalise the resolver result, then validate it. Permission and actor-kind denials stay 403.
  - `@sixthsummit/ship-auth-firebase`: released alongside, so it depends on ship-core and ship-hono 1.1 and no longer pulls in nested 1.0 copies. `resolveActor` may return a kind-less actor.
  - `@sixthsummit/ship-api`: re-exports the new helpers and types.

- [#140](https://github.com/SixthSummit/ship-api/pull/140) [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add real PostgreSQL + Redis + Socket.IO integration coverage for transactional publication through
  the `ship-realtime.publication` outbox: commit-then-dispatch delivery, rollback, crash recovery and
  `dedupeKey`. No runtime change.
- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189), [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`491d017`](https://github.com/SixthSummit/ship-api/commit/491d01749cfb7cee49be7302ed90f63eb8e36d6a), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d), [`f38e572`](https://github.com/SixthSummit/ship-api/commit/f38e57225815489a274582e9b930c3c96480d496), [`24d78b0`](https://github.com/SixthSummit/ship-api/commit/24d78b0dfcffa4964d16bb9a2616e5885485b5e3), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`ff6dc11`](https://github.com/SixthSummit/ship-api/commit/ff6dc11675478ed7abb8080dad1a8009267722f7), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`bb00927`](https://github.com/SixthSummit/ship-api/commit/bb00927fae0aa18bf3b0d8d1e1c91ee1b35c24dc), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0
  - @sixthsummit/ship-hono@1.1.0
  - @sixthsummit/ship-observability-otel@1.1.0
