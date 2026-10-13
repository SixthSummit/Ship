# @sixthsummit/ship-auth-firebase

## 1.1.0

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

## 1.0.1

### Patch Changes

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep actors without `kind` working within 1.x, so authenticated requests no longer fail with 500 when an older adapter is in the tree.

  An actor built on ship-core 1.0 has no `kind`. ship-auth-firebase 1.0 rebuilds the actor its `resolveActor` returns with its own ship-core copy, which npm nests next to a prerelease ship-core 1.1, so the HTTP adapter received a kind-less actor, rejected the resolution as "an invalid result" and answered 500 (including where the right answer was 403).

  - `@sixthsummit/ship-core`: new `normalizeActorResolution()` and `normalizeOperationActor()` fill in `kind: "human"` for a kind-less actor before validating it, and `isActorResolution()` accepts such resolutions. A kind-less actor can never carry `provider` or `onBehalfOf`, so it can't claim system or provider status. `executor.run()` normalises its `actor` option the same way. Resolver results and `executor.run()` take the new `OperationActorInput` type (`OperationActor | LegacyOperationActor`), so 1.0-typed resolvers compile again. `OperationActor`, which handlers see, still always has `kind`.
  - `@sixthsummit/ship-hono` and `@sixthsummit/ship-realtime-socketio`: normalise the resolver result, then validate it. Permission and actor-kind denials stay 403.
  - `@sixthsummit/ship-auth-firebase`: released alongside, so it depends on ship-core and ship-hono 1.1 and no longer pulls in nested 1.0 copies. `resolveActor` may return a kind-less actor.
  - `@sixthsummit/ship-api`: re-exports the new helpers and types.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189), [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`491d017`](https://github.com/SixthSummit/ship-api/commit/491d01749cfb7cee49be7302ed90f63eb8e36d6a), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d), [`f38e572`](https://github.com/SixthSummit/ship-api/commit/f38e57225815489a274582e9b930c3c96480d496), [`24d78b0`](https://github.com/SixthSummit/ship-api/commit/24d78b0dfcffa4964d16bb9a2616e5885485b5e3), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`ff6dc11`](https://github.com/SixthSummit/ship-api/commit/ff6dc11675478ed7abb8080dad1a8009267722f7), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`bb00927`](https://github.com/SixthSummit/ship-api/commit/bb00927fae0aa18bf3b0d8d1e1c91ee1b35c24dc), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0
  - @sixthsummit/ship-hono@1.1.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`c2cab9e`](https://github.com/SixthSummit/ship-api/commit/c2cab9eda39867d9f3642652b8a5f95c38515d36) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish strict Firebase bearer extraction and kernel-native actor resolution without assuming an account table, ORM, tenant model, or Hono route-tree type.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`059229c`](https://github.com/SixthSummit/ship-api/commit/059229c9f4c13ff18c5f6873176e034304718b44) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an explicit forwarded-authorization precedence policy so applications can
  preserve trusted-proxy authentication contracts without implicit header order.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

### Patch Changes

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@1.0.0
  - @sixthsummit/ship-hono@1.0.0

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`c2cab9e`](https://github.com/SixthSummit/ship-api/commit/c2cab9eda39867d9f3642652b8a5f95c38515d36) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish strict Firebase bearer extraction and kernel-native actor resolution without assuming an account table, ORM, tenant model, or Hono route-tree type.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`059229c`](https://github.com/SixthSummit/ship-api/commit/059229c9f4c13ff18c5f6873176e034304718b44) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an explicit forwarded-authorization precedence policy so applications can
  preserve trusted-proxy authentication contracts without implicit header order.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

### Patch Changes

- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@0.1.0-alpha.1
  - @sixthsummit/ship-hono@0.1.0-alpha.1
