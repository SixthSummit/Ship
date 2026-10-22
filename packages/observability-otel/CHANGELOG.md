# @sixthsummit/ship-observability-otel

## 1.3.0

### Minor Changes

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

## 1.1.0

### Minor Changes

- [#138](https://github.com/SixthSummit/ship-api/pull/138) [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add inbound webhook operations (ADR-0018).

  - `@sixthsummit/ship-core`: `defineWebhook` compiles a bounded raw-body POST operation with `providerAccess`, a pure `WebhookVerifier` contract with explicit guarantees, rotatable `WebhookSecretSource`s, executor-enforced idempotency with a declared in-flight policy, inline or enqueue (receive-then-process) modes, `webhookIntent`, `defineWebhookReplay`, `defineWebhookCleanup`, the `WebhookEventStore` contract, a `WebhookObserver` hook, and edge-safe WebCrypto helpers. The executor reports `SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE` for store outages and marks replayed results with `replayed: true`.
  - `@sixthsummit/ship-hono`: `createHonoAdapter({ webhooks: { publicBaseUrl, observer } })` verifies exact bytes before any actor exists, derives canonical URLs from the declared base URL, and maps outcomes to stable `WEBHOOK_*` responses.
  - `@sixthsummit/ship-drizzle`: `shipWebhookEventsTable` and `createDrizzleWebhookEventStore` with retention cleanup that never deletes undispatched events.
  - `@sixthsummit/ship-testing`: `createInMemoryWebhookEventStore`, `fakeWebhookProvider`, and `purgeExpired` on the in-memory idempotency store.
  - `@sixthsummit/ship-contract`: webhook operations are excluded from the browser manifest and documented in OpenAPI under `x-ship-webhook`.
  - `@sixthsummit/ship-observability-otel`: `createWebhookMetrics` records receive outcomes, verification failures, duplicates and receive-to-dispatch lag.
  - `@sixthsummit/ship-webhooks` (new, `0.1.0-alpha.0`): subpath verifiers for Stripe, GitHub, Slack, Twilio, Resend, HighLevel and a documented shared-secret fallback.

### Patch Changes

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish tracing helpers, OpenTelemetry SDK lifecycle, and Prometheus metrics on explicit `@sixthsummit/ship-observability-otel` entrypoints. The monolithic observability paths become deprecated compatibility re-exports.

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish tracing helpers, OpenTelemetry SDK lifecycle, and Prometheus metrics on explicit `@sixthsummit/ship-observability-otel` entrypoints. The monolithic observability paths become deprecated compatibility re-exports.
