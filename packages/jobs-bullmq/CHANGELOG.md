# @sixthsummit/ship-jobs-bullmq

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

## 0.1.0

### Minor Changes

- [#169](https://github.com/SixthSummit/ship-api/pull/169) [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add optional bounded result observation to durable job backends and a synchronous HTTP job projection. BullMQ retains completed results and final failures while a timed-out HTTP request returns the durable run ID for reconciliation without cancelling the job. A delivery dedupe key can reuse a retained terminal run, preventing a scheduler retry from replaying the effect.

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - New package: BullMQ `JobBackend` (queues, workers, upserted job schedulers, queue-full backpressure, dead-letter retry/discard, retention cleanup, graceful quit), `createRedisLockProvider` and `ship.job.*` OpenTelemetry metrics.

### Patch Changes

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0
