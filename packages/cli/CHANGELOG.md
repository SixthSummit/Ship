# @sixthsummit/ship-cli

## 1.1.0

### Minor Changes

- [#139](https://github.com/SixthSummit/ship-api/pull/139) [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `inspect job <id>`, job counts and retained compiler warnings in `check`, `affected job <id>`, and declaration-time `SHIP_*` errors reported as exit-1 diagnostics.

- [#135](https://github.com/SixthSummit/ship-api/pull/135) [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a declared read cache with framework-owned keys and durable tag invalidation (ADR-0019).

  - `defineOperation` accepts `cache: { ttlMs, scope: "actor" | "tenant" | "public", vary?, tags?, tenant? }` on `transaction: "none"` and `"read"` operations. The executor derives every key from the operation id, its graph version, the actor id or the identifier of an authentic `TenantScope`, the canonical validated input and `vary` — a consumer cannot supply a raw key. Hits replay the stored success and are marked `cache: "hit"`; declared failures are never cached; concurrent misses for one key are coalesced. Streaming operations bypass the read cache: `cache` on a `transport.response.mode: "stream"` operation fails compilation with `SHIP_OPERATION_STREAM_CACHE_FORBIDDEN`.
  - `invalidates: readonly string[]` on `transaction: "write"` operations records one durable purge intent per tag through the framework-owned `ship-cache.invalidation` outbox inside the write transaction, so a rollback leaves none. Mount `defineCacheInvalidationModule({ cache, outbox })` once; the generated dispatcher performs the purge after commit. Invalidation is eventual.
  - `CacheBackend` (`get`, `set`, `del`, `delByTag`, `health`, optional `singleFlight`) is bound with `cacheBackendDependency(id)`. New diagnostics: `SHIP_CACHE_TRANSACTION_FORBIDDEN`, `SHIP_CACHE_BACKEND_UNBOUND`, `SHIP_CACHE_SCOPE_ACTOR_INVALID`, `SHIP_CACHE_INVALIDATES_TRANSACTION_INVALID`, `SHIP_CACHE_INVALIDATION_DISPATCHER_MISSING`, `SHIP_CACHE_PROVIDER_LIFETIME_INVALID`, and the `SHIP_CACHE_TAG_UNKNOWN` warning carried in `graph.diagnostics`.
  - `@sixthsummit/ship-cache-redis` (new): `createRedisCacheBackend` stores JSON with millisecond TTLs and TTL-matched Redis tag sets, driver-free through a small `RedisLike` client interface.
  - `@sixthsummit/ship-testing`: `createInMemoryCacheBackend` and the runner-agnostic `cacheBackendConformance` suite both adapters pass.
  - `@sixthsummit/ship-hono`: cached responses carry `x-ship-cache: hit|miss` (a reserved header) and the declared `Cache-Control`.
  - `@sixthsummit/ship-contract`: the client contract and OpenAPI carry cache policy, `Cache-Control` and `X-Ship-Cache`.
  - `@sixthsummit/ship-cli`: `inspect` prints cache policy and invalidated tags, `affected` follows tag edges from a write to the cached reads it purges, and `check` reports compilation warnings.

- [#144](https://github.com/SixthSummit/ship-api/pull/144) [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Improve declared caching and jobs conformance (ADR-0019 and ADR-0015 addenda).

  - `Cache-Control` projects `public` only when the operation's access is `publicAccess()`; a `scope: "public"` read behind any other access projects `private, max-age=N` everywhere (`ship-hono`, graph, contract, OpenAPI). `cacheControlHeader(cache, access?)` takes the access; omitted, it projects private. New diagnostics: `SHIP_CACHE_PUBLIC_SCOPE_PROTECTED` (warning), `SHIP_CACHE_PUBLIC_SCOPE_FORBIDDEN` (error, optional-identity access).
  - `invalidates` accepts `{ tag, scope: "actor" }` and `{ tag, scope: "tenant", tenant }` beside plain tags. Actor- and tenant-scoped reads store entries under `scopedCacheTag(tag, scopeKey)` as well as the plain tag; a scoped write records `{ tag, scope }` and the dispatcher purges only that subject's entries. Compiled `operation.invalidates` becomes `{ tag, scope, tenant? }[]`; the graph adds `invalidatesScoped`. New diagnostics: `SHIP_CACHE_INVALIDATES_ACTOR_INVALID` (error), `SHIP_CACHE_TAG_SCOPE_UNMATCHED` (warning). Executor: `SHIP_OPERATION_CACHE_ACTOR_INVALID`.
  - `cache.vary(input, subject)` receives a read-only `{ actor, context }`; `SHIP_CACHE_VARY_SUBJECT_PUBLIC` warns when a public read's `vary` reads it.
  - `defineCacheInvalidationModule({ backend })` binds and exports the `cacheBackendDependency` token so modules with cached reads import `ship-cache` and bind nothing.
  - `@sixthsummit/ship-testing`: `cacheBackendConformance` proves scoped tags stay independent; `@sixthsummit/ship-cache-redis` passes it and the executor-level tenant/actor isolation test against real Redis.
  - `@sixthsummit/ship-cli`: `inspect app|module` lists declared and framework-introduced permissions (`ship.outbox:manage`, `ship.jobs:manage`, `ship.webhooks:replay`); `inspect operation` renders scoped invalidations.
  - Jobs: `defineJob` accepts `retention.completedMs: 0` / `deadLetteredMs: 0` (collect on the next sweep); `startJobRuntime` returns `liveness(now?)` with per-job `lastStartedAt`/`lastCompletedAt`/`lastFailedAt`/`completed`/`failed`/`lagMs`; `ship-hono` adds `jobLivenessRoute({ runtime, staleAfterMs?, path? })` and `projectJobLiveness`; `SHIP_MODULE_OPERATION_ID_MISMATCH` explains the job-id and `defineJobManagement` prefix rule.

### Patch Changes

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189), [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`38e26e3`](https://github.com/SixthSummit/ship-api/commit/38e26e37ad90a5c01f9373d65220a2a4236e5168), [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc), [`319f350`](https://github.com/SixthSummit/ship-api/commit/319f350a67e125d354a6edcfb67fd88bb38a3b27), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`c8d7c9f`](https://github.com/SixthSummit/ship-api/commit/c8d7c9f7e5ce96e4f51c4eeffc63b32234589c9f), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-contract@1.2.0

## 1.0.0

### Major Changes

- [#119](https://github.com/SixthSummit/ship-api/pull/119) [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Promote the operation framework packages to their first stable 1.0 release.
  Keep the existing ShipAPI compatibility distribution on its 4.0 release line.
  This records the stable version boundary required by SAPI-54; it does not change runtime behavior.

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`1f79ef5`](https://github.com/SixthSummit/ship-api/commit/1f79ef50dc80dbdced33f031a286542d253100b2) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `ship-api migrate-routes` and a programmatic migration checker that require
  every catalogued legacy route to map exactly once to an HTTP operation or an
  approved removal. The checker rejects stale revisions, duplicate dispositions,
  unknown targets, and method/path drift with stable diagnostics.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`7c57c0f`](https://github.com/SixthSummit/ship-api/commit/7c57c0f32f80dbac97ae842dcc80e1cb1f527440) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a tested operation-native application scaffold with exact compatible Ship
  package pins, Biome and TypeScript gates, 80% coverage thresholds, and repository
  commit and pull-request conventions.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish application graph validation, inspection, impact analysis, and contract
  generation as the focused `@sixthsummit/ship-cli` package. The monolithic CLI
  retains these commands through compatibility re-exports while its legacy
  scaffold and migration commands remain isolated from the new tool surface.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`fec66de`](https://github.com/SixthSummit/ship-api/commit/fec66de7e605748c4c80269de40cf092730c5b6a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Run the installed command through a dedicated unconditional bin module. This
  avoids silently skipping the CLI when a package-manager symlink makes
  `process.argv[1]` differ from the resolved implementation module URL.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Expose an import-free primitive operation form projection with explicit initial presence and
  codecs, and verify generated contracts/clients with the retained Angular joint fixture.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`d3ce43b`](https://github.com/SixthSummit/ship-api/commit/d3ce43bec75dcdbfc316db341459735f48aa37ab) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Pin operation-native generated applications to pnpm 10.34.5 and emit them from package archives
  whose dependency maps are verified as reproducible across independent clean builds.
- Updated dependencies [[`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa), [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5)]:
  - @sixthsummit/ship-contract@1.0.0

## 0.1.0-alpha.1

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`1f79ef5`](https://github.com/SixthSummit/ship-api/commit/1f79ef50dc80dbdced33f031a286542d253100b2) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `ship-api migrate-routes` and a programmatic migration checker that require
  every catalogued legacy route to map exactly once to an HTTP operation or an
  approved removal. The checker rejects stale revisions, duplicate dispositions,
  unknown targets, and method/path drift with stable diagnostics.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`7c57c0f`](https://github.com/SixthSummit/ship-api/commit/7c57c0f32f80dbac97ae842dcc80e1cb1f527440) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a tested operation-native application scaffold with exact compatible Ship
  package pins, Biome and TypeScript gates, 80% coverage thresholds, and repository
  commit and pull-request conventions.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish application graph validation, inspection, impact analysis, and contract
  generation as the focused `@sixthsummit/ship-cli` package. The monolithic CLI
  retains these commands through compatibility re-exports while its legacy
  scaffold and migration commands remain isolated from the new tool surface.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`fec66de`](https://github.com/SixthSummit/ship-api/commit/fec66de7e605748c4c80269de40cf092730c5b6a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Run the installed command through a dedicated unconditional bin module. This
  avoids silently skipping the CLI when a package-manager symlink makes
  `process.argv[1]` differ from the resolved implementation module URL.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Expose an import-free primitive operation form projection with explicit initial presence and
  codecs, and verify generated contracts/clients with the retained Angular joint fixture.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`d3ce43b`](https://github.com/SixthSummit/ship-api/commit/d3ce43bec75dcdbfc316db341459735f48aa37ab) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Pin operation-native generated applications to pnpm 10.34.5 and emit them from package archives
  whose dependency maps are verified as reproducible across independent clean builds.
- Updated dependencies [[`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa), [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7)]:
  - @sixthsummit/ship-contract@0.1.0-alpha.1
