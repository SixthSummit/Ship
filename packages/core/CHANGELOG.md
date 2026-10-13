# @sixthsummit/ship-api

## 4.1.1

### Patch Changes

- 8f71663: License the framework under Apache-2.0, include LICENSE and NOTICE in published packages, and update package documentation.

  Remove application-specific documentation and replace client-derived regression fixtures with synthetic framework examples.
- 6cac2d2: Require patched Hono releases and prepare public npm distribution under the existing package names.
- Updated dependencies [8f71663]
- Updated dependencies [8f71663]
- Updated dependencies [6cac2d2]
  - @sixthsummit/ship-hono@1.2.0
  - @sixthsummit/ship-drizzle@1.2.0
  - @sixthsummit/ship-contract@1.3.0
  - @sixthsummit/ship-cli@1.2.0
  - @sixthsummit/ship-observability-otel@1.2.0
  - @sixthsummit/ship-core@1.1.1

## 4.1.0

### Minor Changes

- [#172](https://github.com/SixthSummit/ship-api/pull/172) [`5336fc3`](https://github.com/SixthSummit/ship-api/commit/5336fc3b413d13859b0793209df4289495d6d49d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `createApp()` now mounts `GET /livez` and `GET /readyz` by default, and `createDb()` registers a `db.primary` readiness check. Apps that shipped without health routes get them on upgrade with no code change.

  - **Default routes.** The routes are mounted unauthenticated, before any route or middleware the app adds, and are kept out of the route registry. Configure them with `createApp({ health: { prefix, readyzTimeoutMs, registry } })` or opt out with `createApp({ health: false })`. `/healthz` is deliberately not mounted, because Google Cloud Run's front end intercepts that path.
  - **Existing `registerHealthRoutes(app)` calls keep working.** On an app that already has the routes the call mounts nothing and never throws. A `registry` or `readyzTimeoutMs` it passes is applied to the mounted routes, so an app that hands in its own registry keeps its checks. A different `prefix` is ignored with a warning; move it to `createApp({ health: { prefix } })`. `hasHealthRoutes(app)` reports whether an app has them.
  - **Default `db.primary` check.** `createDb()` adds a check that runs `select 1` on its pool and reports real latency. Opt out with `createDb({ ..., healthCheck: false })` (for secondary pools, say), or rename it with `healthCheck: { name }`. The check is also exported as `dbHealthCheck(pool)` from `@sixthsummit/ship-api/app/db/client`.
  - **Duplicate check names no longer throw.** `HealthCheckRegistry.add()` used to throw on a duplicate name. Now the first registration wins and later ones are skipped, and `add()` returns `false`. The exception is a check added with `{ replaceable: true }`, which `createDb` uses: a later explicit registration of the same name replaces it. So an app that registers its own `db.primary` after `createDb()` runs exactly one check, its own.
  - **`/readyz` no longer returns raw error text.** A failed check now reports only `name`, `ok`, `latencyMs` and `error: "timeout"` or `"unavailable"`. Check `details` are no longer included in the body either. Previously the thrown message, which for a database error can include the host, port or user, was returned on a public endpoint. Failures are logged server-side as a warn-level `Readiness check failed` line: a thrown error contributes only its `errorCode` / `errorName` / `syscall`, never the message, and a returned `error` string is logged as `reason`. `runAll()` still returns the raw `error` and `details` to direct callers, and its new `onCheckFailure` option receives the raw error.
  - `registerHealthRoutes`, `hasHealthRoutes` and `redisHealthCheck` are now exported from the package root, as the docs already showed.

  Upgrade notes: an app that defines its own `GET /livez` or `GET /readyz` after `createApp()` is now shadowed by the framework's route, so delete yours or pass `health: false`. Middleware registered before a manual `registerHealthRoutes` call, such as `httpLogger`, no longer runs for the health routes. Tests that assert the raw error string in a `/readyz` body, or that rely on `add()` throwing on duplicates, need updating.

### Patch Changes

- [#175](https://github.com/SixthSummit/ship-api/pull/175) [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep `ActorResolution` as the 1.0 contract: a successful resolution's `actor` is always an `OperationActor` with a `kind`. The previous change widened it to accept kind-less actors, which broke code that passes `resolver.resolve(...)`'s actor on as an `OperationActor` (TS2322).

  Resolver authors still get the leniency: `defineActorResolver()` now takes an `ActorResolverDefinition`, whose `resolve` may return an `ActorResolutionResult` with a ship-core 1.0 actor, and the returned resolver normalises every result (missing `kind` becomes `human`) before any caller sees it. An invalid result is still passed through for the request boundary to reject. `isActorResolution()` now guards `ActorResolutionResult`; `NormalizedActorResolution` is a deprecated alias of `ActorResolution`.

- [#173](https://github.com/SixthSummit/ship-api/pull/173) [`208b4a9`](https://github.com/SixthSummit/ship-api/commit/208b4a92e0aa959d426d1c36adfa71402aa0b1d0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Deprecate configuring health routes after `createApp`. Since `createApp` mounts `/livez` and `/readyz` by default, a later `registerHealthRoutes(app, { registry })` or `{ readyzTimeoutMs }` still updates the mounted routes, so existing apps keep their checks, but it now logs a one-time warning per app. Pass those options to `createApp({ health: { … } })` instead; late configuration will be removed in the next major version. A bare `registerHealthRoutes(app)` with no options is unaffected and stays silent.

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Keep actors without `kind` working within 1.x, so authenticated requests no longer fail with 500 when an older adapter is in the tree.

  An actor built on ship-core 1.0 has no `kind`. ship-auth-firebase 1.0 rebuilds the actor its `resolveActor` returns with its own ship-core copy, which npm nests next to a prerelease ship-core 1.1, so the HTTP adapter received a kind-less actor, rejected the resolution as "an invalid result" and answered 500 (including where the right answer was 403).

  - `@sixthsummit/ship-core`: new `normalizeActorResolution()` and `normalizeOperationActor()` fill in `kind: "human"` for a kind-less actor before validating it, and `isActorResolution()` accepts such resolutions. A kind-less actor can never carry `provider` or `onBehalfOf`, so it can't claim system or provider status. `executor.run()` normalises its `actor` option the same way. Resolver results and `executor.run()` take the new `OperationActorInput` type (`OperationActor | LegacyOperationActor`), so 1.0-typed resolvers compile again. `OperationActor`, which handlers see, still always has `kind`.
  - `@sixthsummit/ship-hono` and `@sixthsummit/ship-realtime-socketio`: normalise the resolver result, then validate it. Permission and actor-kind denials stay 403.
  - `@sixthsummit/ship-auth-firebase`: released alongside, so it depends on ship-core and ship-hono 1.1 and no longer pulls in nested 1.0 copies. `resolveActor` may return a kind-less actor.
  - `@sixthsummit/ship-api`: re-exports the new helpers and types.

- [#171](https://github.com/SixthSummit/ship-api/pull/171) [`ee68fdb`](https://github.com/SixthSummit/ship-api/commit/ee68fdbeadf95d0d370430d2b5e2652b53e8585e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Stop a dropped idle database connection from crashing the process. `createPool` and `createDb` now attach the pool `error` listener that `pg` requires: when Cloud SQL restarts, fails over or runs maintenance, Postgres ends idle connections with `57P01`, and without a listener Node exits on the uncaught event. The pool discards the broken client and logs a warning carrying only the error's `errorCode`, `errorName` and `syscall` (the raw message can include connection details). `handleIdleClientErrors(pool)` is exported from `app/db/client` for pools built directly with `new pg.Pool()`, such as migration scripts; a pool that already has an `error` listener is left alone.

- [#174](https://github.com/SixthSummit/ship-api/pull/174) [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Log why a readiness check that returned a failure failed. A check that returns `{ ok: false, error: "..." }` (the documented shape) used to leave no cause in either the `/readyz` body or the log. The warn-level `Readiness check failed` line now includes that string as `reason`, truncated to 200 characters. The string is written by the app author, so it must not contain secrets. Thrown errors are still logged by `errorCode` / `errorName` / `syscall` only, never the message. The `/readyz` body stays generic. `HealthCheckFailure` gains an optional `reason` field for `runAll({ onCheckFailure })` callers.

  The pool's idle-connection error log now uses the same field names as the readiness log (`errorCode`, `errorName`, `syscall`) instead of `code` / `errorName`.

- [#156](https://github.com/SixthSummit/ship-api/pull/156) [`d63141b`](https://github.com/SixthSummit/ship-api/commit/d63141bc5ec0267813c72c64db9dc0382ee8d071) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Expose the Redis and in-memory sliding-window backends through the stable `@sixthsummit/ship-api/rate-limit` subpath.

- [#129](https://github.com/SixthSummit/ship-api/pull/129) [`da6920e`](https://github.com/SixthSummit/ship-api/commit/da6920efd6525ce6de43e94fb51d7adf2474d2c5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Move the `ship-api create` scaffold template's `@sixthsummit/ship-observability-otel`
  pin from `^0.1.0-alpha.0` to the published stable `^1.0.0`, and make the MCP
  server advertise its own `package.json` version to clients instead of a
  hard-coded `0.1.0-alpha.0` default.

- [#133](https://github.com/SixthSummit/ship-api/pull/133) [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `libraries/ai` exports `streamLLM(stream, events, options?)`, which pipes an `LLMProvider.streamComplete()` iterator through a kernel streaming operation's `stream.emit` with abort propagation. The compatibility Hono `streamLLM(c, events)` helper is unchanged.

- Updated dependencies [[`c707304`](https://github.com/SixthSummit/ship-api/commit/c7073046e198f2c9a8006a4968d7976d2b7912fe), [`b621658`](https://github.com/SixthSummit/ship-api/commit/b6216588fe38180a9008e95df9b4e3d4994d9d7b), [`ba84e9f`](https://github.com/SixthSummit/ship-api/commit/ba84e9f4d2e2aa9e97da246c8ef546f2f3b0899a), [`d48e64e`](https://github.com/SixthSummit/ship-api/commit/d48e64ef706a4721ab0a8799ffab6550b7ada189), [`fb331f7`](https://github.com/SixthSummit/ship-api/commit/fb331f7ee6b153ce1c647b7d09706ca3607ed528), [`3d4d978`](https://github.com/SixthSummit/ship-api/commit/3d4d9788de3374baa40b7a52af46ea126cf79568), [`5df1434`](https://github.com/SixthSummit/ship-api/commit/5df1434cd5d08d2fe42453a816d60a77d85fe5ce), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`8c9a40b`](https://github.com/SixthSummit/ship-api/commit/8c9a40baa2404e5dcdaa80d72709f8f31523e1cc), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`f8c8f08`](https://github.com/SixthSummit/ship-api/commit/f8c8f08476b6fa09ef1bb603e46386d41632f0c7), [`7108383`](https://github.com/SixthSummit/ship-api/commit/7108383cbf31fed08fd458a3b091600ea8bc773c), [`491d017`](https://github.com/SixthSummit/ship-api/commit/491d01749cfb7cee49be7302ed90f63eb8e36d6a), [`1b6dd5e`](https://github.com/SixthSummit/ship-api/commit/1b6dd5e4018d1b9e2684499d5733fcbc7f7299af), [`b9fefa5`](https://github.com/SixthSummit/ship-api/commit/b9fefa5ff8941ed6abdda0f5ee548720dea3d93d), [`f38e572`](https://github.com/SixthSummit/ship-api/commit/f38e57225815489a274582e9b930c3c96480d496), [`24d78b0`](https://github.com/SixthSummit/ship-api/commit/24d78b0dfcffa4964d16bb9a2616e5885485b5e3), [`8d41857`](https://github.com/SixthSummit/ship-api/commit/8d41857da9f532aeb6f8efd6027f9f4dcc0d9c34), [`446914d`](https://github.com/SixthSummit/ship-api/commit/446914d9c31c56ce747e0b545bad485c49f0ca7c), [`38e26e3`](https://github.com/SixthSummit/ship-api/commit/38e26e37ad90a5c01f9373d65220a2a4236e5168), [`9575faf`](https://github.com/SixthSummit/ship-api/commit/9575faf4ad55927991c9e49e668bca856247b8fc), [`319f350`](https://github.com/SixthSummit/ship-api/commit/319f350a67e125d354a6edcfb67fd88bb38a3b27), [`8bbd076`](https://github.com/SixthSummit/ship-api/commit/8bbd076585d94c934fc852ba4a46b59859b770cc), [`ff6dc11`](https://github.com/SixthSummit/ship-api/commit/ff6dc11675478ed7abb8080dad1a8009267722f7), [`c3b5133`](https://github.com/SixthSummit/ship-api/commit/c3b51336bfa03ef8536fc4bc982522f9bb1c8d47), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`ec9dc2d`](https://github.com/SixthSummit/ship-api/commit/ec9dc2d4edfcb109a7d8a0526144a57577317647), [`1e90972`](https://github.com/SixthSummit/ship-api/commit/1e90972cf11cb9f613fa342c2ee32b479e6f78b9), [`962b364`](https://github.com/SixthSummit/ship-api/commit/962b36403d27849a960121b6d10b83580394c97d), [`bb00927`](https://github.com/SixthSummit/ship-api/commit/bb00927fae0aa18bf3b0d8d1e1c91ee1b35c24dc), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`e748de3`](https://github.com/SixthSummit/ship-api/commit/e748de3e2fcab7ddeeaca38b95a912964a9feeec), [`c8d7c9f`](https://github.com/SixthSummit/ship-api/commit/c8d7c9f7e5ce96e4f51c4eeffc63b32234589c9f), [`b7092e6`](https://github.com/SixthSummit/ship-api/commit/b7092e6c9acc4ba156703477ba86d73b4553c0d0), [`bdb6001`](https://github.com/SixthSummit/ship-api/commit/bdb600192079dad65865914021084781cb8bbb8f)]:
  - @sixthsummit/ship-core@1.1.0
  - @sixthsummit/ship-drizzle@1.1.0
  - @sixthsummit/ship-contract@1.2.0
  - @sixthsummit/ship-hono@1.1.0
  - @sixthsummit/ship-cli@1.1.0
  - @sixthsummit/ship-observability-otel@1.1.0

## 4.0.0

### Minor Changes

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`f5b0828`](https://github.com/SixthSummit/ship-api/commit/f5b082809dc13cf27ace9479ce6f7dc68ce179f0) Thanks [@selosindis](https://github.com/selosindis)! - A2-7 — Drizzle hedge lint guard. An ESLint rule (`@typescript-eslint/no-restricted-imports`) that keeps raw Drizzle query operators (`eq`/`and`/`sql`/…) in the data-access layer, so `QueryOptions` stays a real ORM-swap seam instead of an eroding convention.

  - **Scaffolded apps enforce it:** the default template's ESLint config flags a raw `drizzle-orm` value import in any `src/modules/**/services/**` (or route/handler) file; `src/db` + module `schema.ts` are exempt, and type-only imports (`InferSelectModel`, …) are allowed. For specialized access (row locking, raw `sql`) the rule message points at a justified `// eslint-disable-next-line … -- <reason>`.
  - **Closes the subpath bypass:** the operators also re-export from `drizzle-orm/sql`, `…/sql/expressions`, `…/pg-core/expressions`, so the rule blocks those patterns too — `import { eq } from "drizzle-orm/sql"` can't dodge it. `drizzle-orm/pg-core` schema columns stay free.
  - **Bites in-repo too:** the framework now lints `modules/**` (previously ESLint-ignored), so the guard applies to the reference modules; the outbox + oauth services carry a justified `eslint-disable` (the outbox drainer needs row locking + atomic `sql`), which also keeps `ship-api add outbox/oauth` clean under the template rule.
  - Convention documented in `typescript.mdc` + both AGENTS.md. Ceiling: import-free raw access via the `protected db` (`db.query`/`db.select`) is enforced by review, not lint. Adversarially reviewed (2 blockers fixed).

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept lowercase dot-namespaced permission slugs as well as colon-namespaced
  slugs so applications can preserve established RBAC catalogs during migration.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`7f66aca`](https://github.com/SixthSummit/ship-api/commit/7f66aca7d91e5a66d7e264cf7f72ccbc9deae388) Thanks [@selosindis](https://github.com/selosindis)! - AI-R1 — the `libraries/ai` provider seam is now genuinely **pass-through**, not lowest-common-denominator. The seam already accepted `providerOptions` inbound but discarded native features outbound; this completes the round-trip so multi-provider apps keep the native capabilities they paid the provider for.

  - `CompleteResult` and `StreamStopEvent` gain an optional `raw` (untranslated provider response) + `providerExtras`; `TokenUsage` gains `reasoningTokens` + `raw`. All additive-optional (non-breaking).
  - Both adapters now populate them: Anthropic surfaces dropped blocks (thinking / citations / server-tool-use) via `providerExtras.blocks` + the full `raw`; OpenAI surfaces `refusal` + reasoning-token accounting + `raw`.
  - **Bug fix:** `agentLoop` and `retrieveAndAnswer` silently dropped `providerOptions` / `metadata` — they now forward them, so prompt caching / extended thinking can actually be enabled through those entry points.

  (An optional native-`completeStructured` provider method is a non-speculative follow-on — `providerOptions` already lets native structured output pass through `completeStructured` today.)

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`611886a`](https://github.com/SixthSummit/ship-api/commit/611886a3fb07991c4f0f8b19221464723b112b8b) Thanks [@selosindis](https://github.com/selosindis)! - AI-R2 + AI-R3 — thin the two most volatile `libraries/ai` surfaces (alpha-window breaking, deliberate).

  **AI-R2 — `agentLoop` is no longer on the stable surface.** The hand-rolled model→tool→model loop is the piece most likely superseded by MCP / provider-native agent runtimes, so it now lives at `@sixthsummit/ship-api/libraries/ai/experimental` (no stability promise, `@experimental`). **BREAKING:** import `agentLoop` / `collectAssistantText` / `AgentLoopError` / `AgentLoopMaxIterationsError` and its types from the `/experimental` subpath instead of the barrel. The `defineTool` / `toolRegistry` building blocks stay on the stable barrel.

  **AI-R3 — heuristic token counting is deprecated.** `HeuristicTokenizer` and `countMessageTokens` are `@deprecated` (kept exported): token _truth_ is the real usage on the provider response (`CompleteResult.usage` / `StreamStopEvent.usage`, surfaced richer by AI-R1). New thin `estimateTokens` / `estimateMessageTokens` helpers cover the legitimate pre-call prompt-fit / rate-limit-gating use-case, honestly labelled as estimates. The pluggable `Tokenizer` interface is unchanged — a real tiktoken/claude tokenizer still implements it.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`98b5dab`](https://github.com/SixthSummit/ship-api/commit/98b5dab6b19f056a2726760cf73b3e855d937b31) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add authorization-backed tenant capabilities and transaction-scoped tenant repository factories. Tenant repositories now require nominal scope evidence, privileged repository surfaces require a distinct bypass, and bypass issuance and use fail closed unless synchronously audited.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`5e456fd`](https://github.com/SixthSummit/ship-api/commit/5e456fdb93c972b35218f58e3f61f81cdc20daf3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add deterministic application graph commands for validation, inspection, impact queries, and `.ship/graph.json` emission from TypeScript app declarations.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`65c2dc4`](https://github.com/SixthSummit/ship-api/commit/65c2dc4b0f4f9705dbddc0add21706aeccb8f7e5) Thanks [@selosindis](https://github.com/selosindis)! - A2-2 — contract freeze pass (+ A2-3). Locks the public surface apps code and migrate against, documented in `docs/PUBLIC_API_SURFACE.md`: the three export-path stability tiers (`@sixthsummit/ship-api` barrel + `/client` are semver-locked; `/*` deep paths are not), the barrel exports, the column primitives + accounts table shapes, the error-response envelope + code/status mapping, the `module.json` shape, the permission-slug convention, and the `hc()` cross-framework seam.

  - **A2-3 — `QueryFilter` collision resolved.** The query-DSL type in `@sixthsummit/ship-api/app/db/QueryOptions` is renamed `DslQueryFilter`; the lifecycle-hook `QueryFilter` keeps the name and remains the barrel export. Internal rename; consumers importing the DSL type from that deep path update `QueryFilter` → `DslQueryFilter` (deep paths are not semver-locked).
  - **Barrel consistency:** every configurable middleware now exports its `Options` type — `ApiKeyOptions`, `CsrfOptions`, `RateLimitOptions`, `IdempotencyOptions` — alongside the existing `RequireAuthOptions`/`HttpLoggerOptions`. Additive.
  - **`PermissionDefinition`** (`{ slug, label }`) is barrel-exported — the locked permission-seeding shape; each module's `*_PERMISSION_DEFINITIONS` is pinned to it via `satisfies`.
  - Fixed the stale `defaultSchema` reference in the `g module` `module.json` template (→ `accountsSchema`).

  The barrel audit found no incidental exports to trim — it was already minimal and intentional.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`51f86e4`](https://github.com/SixthSummit/ship-api/commit/51f86e44329a27918235c15c81f8654794a1719f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add canonical `http.get/post/put/patch/delete/options` declarations and `createHonoAdapter`, deriving Hono routes directly from compiled operations. The adapter translates path, query, header, and JSON body input, then delegates validation, access, providers, errors, and result checks to the transport-independent executor.

  Expose explicit `@sixthsummit/ship-api/kernel` and `@sixthsummit/ship-api/hono` subpaths so edge consumers can import the supported runtime seam without loading Node-only framework services.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`bbb27a1`](https://github.com/SixthSummit/ship-api/commit/bbb27a12e24ddcf9c63e8367acf32de6ed8eb779) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit JSON, text, and binary operation response modes with deterministic content types and safe application response headers.

  Stabilize the HTTP failure contract, including validation issue details, strict and bounded JSON parsing, `413`/`415` failures, request correlation, and an unexpected-error observer that cannot leak through the wire response.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`2e8e4c7`](https://github.com/SixthSummit/ship-api/commit/2e8e4c7e268160f21edd6e7049572754d2355d57) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `defineApp`/`compileApp` to validate explicit modules as one application graph. Compilation rejects duplicate operations/providers/transports, missing or private dependencies, undeclared imports, ownership mismatches, and module/provider cycles with stable structured diagnostics.

  Compiled applications expose immutable typed lookups and a deterministic, serializable graph projection for future CLI, client, OpenAPI, and impact tooling.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`03511eb`](https://github.com/SixthSummit/ship-api/commit/03511ebc8025571073a90efe377745c8b406fa14) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add transport-independent operation execution with `createExecutor`. The executor authoritatively enforces access, validates and transforms input, resolves scoped dependency graphs, validates output/error details, preserves request identity and cancellation, and returns discriminated success or declared-failure values.

  Add reusable `operationError` definitions and `operationFailure` so error codes, statuses, safe messages, and detail schemas are graph-visible. Undeclared failures, invalid handler output, schema crashes, and provider failures produce stable exceptional diagnostics instead of leaking as expected API errors.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`22efa4c`](https://github.com/SixthSummit/ship-api/commit/22efa4c0b7a41891ff4fa0682b1f894cd1c82f43) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add immutable `defineModule`, `defineProvider`, and `valueProvider` declarations to the application kernel. Modules explicitly list operations, providers, imports, and exported capabilities; provider factories receive only their typed declared dependencies and choose singleton or operation lifetime.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f588e49`](https://github.com/SixthSummit/ship-api/commit/f588e4909ed86c772ea377fb5d3c1167a8da47d3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the first agent-native kernel contract: `defineOperation` creates immutable, runtime-validated operation declarations with Standard Schema input/output inference, explicit access and transaction modes, stable error codes, typed dependencies, and optional transport metadata.

  Handlers return the default success body directly or use `respond(status, body)` for an alternate declared success. This is additive beside the existing v4 Hono APIs while the compiled graph and adapters are built and proven.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#108](https://github.com/SixthSummit/ship-api/pull/108) [`fc89bcc`](https://github.com/SixthSummit/ship-api/commit/fc89bccb69567b0dcfcb4bf6d8a7cc54a69505cb) Thanks [@selosindis](https://github.com/selosindis)! - Scale the typed `hc()` client to many modules: mount module sub-apps at the root instead of chaining onto one app.

  Composing every module's routes onto a single Hono app accumulates one giant route-type that overflows `tsc` (TS2589 / "instantiation excessively deep", or a hard `RangeError` in the type checker) once an app has enough modules — collapsing the typed client to `never` on consumers. v4 now composes modules as **independent sub-apps mounted at the root**, which keeps each route-type instantiation bounded and lets the typed client scale ~4× further, with **no change to the client shape** (routes keep their absolute paths, so `api.accounts.$get` is unchanged) and no codegen.

  New:

  - `createModuleApp(name)` — a CORS-less `createApp` sibling for building a module sub-app. Tags every captured route with its module, lighting up the Module column in `/dev/routes` and the `module` filter in `list_routes`. Fails fast (throws at dev time) if a sub-app sets `onError` / `notFound` / global `use("*")` — those cross-cutting concerns belong on the root, and silently shadowing them is the one real footgun of the sub-app model.
  - `buildAccountsApp` / `buildOAuthApp` / `buildOutboxApp` — each reference module now exposes a builder returning its own sub-app.
  - `ShipApiSuccessClient<App>` — a success-only (`200 | 201`) client type via Hono's `PickResponseByStatusCode`, for apps that handle errors centrally (the default, via `registerErrorHandlers`).
  - The scaffold (`ship-api g module|resource`) emits the new `buildXxxApp` + `root.route("/", ...)` wiring; the app template emits declarations + a materialized `hcWithType` client for cheaper cross-package typing.

  **Breaking (composition only):** wire modules with `const app = root.route("/", buildXxxApp(deps))` and point `ShipApiClient` at the result, instead of threading one app through `defineXxxRoutes(app, deps)`. `defineXxxRoutes(app, deps)` is retained for advanced composition but is now flagged as a scaling foot-gun. Keep `registerErrorHandlers` + `httpLogger` + cors on the **root only** — never on a module sub-app (a sub-app `onError` would shadow the uniform AppError shape).

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f83fc6c`](https://github.com/SixthSummit/ship-api/commit/f83fc6c76c38ac8fbf1a1d1ba39286de361e9269) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add transport-independent actor resolvers, immutable per-invocation permission snapshots, and explicit Hono credential adapters. Generated HTTP routes now resolve actors and reject unauthorized requests before body parsing while the operation executor remains the authoritative access boundary.

  Add `honoAuthProvider()` as a migration bridge for existing v4 `AuthProvider` implementations, with stable 401, 403, and 503 authentication outcomes.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baead03`](https://github.com/SixthSummit/ship-api/commit/baead0331d7370d77add9c9fa1e6685291990937) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project deterministic client and OpenAPI contracts from compiled operations. Add a browser-safe structural operation client with typed operation IDs, inputs, success/error values, codecs, response metadata, JSON/text/binary representations, stable protocol diagnostics, and unambiguous query-array serialization.

  Add `ship-api contract` to emit fingerprinted `.ship/contract.json` and `.ship/openapi.json` artifacts. Application error declarations can no longer reuse framework-owned validation, authentication, authorization, payload, media, internal, or authentication-availability codes.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`fe2dd84`](https://github.com/SixthSummit/ship-api/commit/fe2dd849c8b33cad933a84e028bdef63c65827cc) Thanks [@selosindis](https://github.com/selosindis)! - A2-6 — v3↔v4 behavioral-parity harness (started). A differential harness that pins v4's observable behavior against v3's — error envelopes, auth edge cases, pagination/validation/query semantics — to capture the "wasting-asset" parity oracle while running v3 apps still exist (the codemod proved structural migration; this proves behavioral parity).

  - Ships `runParityFixture()` + `parseParityFixtures()` + the JSONL fixture format from `@sixthsummit/ship-api/testing`, so a migrated app runs its captured v3 fixtures against its v4 build — in-process via Hono `app.request()`, no Docker.
  - New `npm run test:parity` gate (`vitest.parity.config.ts`); `*.parity.test.ts` is excluded from the unit run.
  - Seeds `v4-conformance` fixtures that lock the documented error-response envelope + the auth-401 contract today — proving the harness and guarding v4 against regressing its own contract.
  - Capture procedure + rationale in `docs/v4/tooling/parity-harness.md`.

  Capturing real `v3-capture` fixtures from a live v3 app is the maintainer's step (there is no v3 app in this repo).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`4c598d9`](https://github.com/SixthSummit/ship-api/commit/4c598d9ae378614b1d99a77464c71d5641909dc8) Thanks [@selosindis](https://github.com/selosindis)! - Identity + RBAC schema (`accounts`, `roles`, `permissions`, `role_permissions`, `refresh_tokens`) has moved out of framework core (`@sixthsummit/ship-api/app/schema`) into the `accounts` module, so the framework stays incrementally adoptable — each app owns and tailors its own identity model. Core now ships **zero concrete tables** — only the primitives: `baseFields`, the `AuthProvider` interface, `DrizzleEntityService`, and the JWT-auth machinery (`JwtSigner`, the `RefreshTokenStore` interface, the generic `DrizzleRefreshTokenStore`, and `AuthFlow`), which receive the concrete `refresh_tokens` table via DI.

  **BREAKING**: import `accounts` / `roles` / `permissions` / `refresh_tokens` from the accounts module, not from `@sixthsummit/ship-api/app/schema` — that subpath and the `defaultSchema` / `DefaultSchema` exports have been **removed**. Compose the module's exported `accountsSchema` fragment into `createApp({ schema })` (and into the testcontainer harness, now re-exported cleanly as `@sixthsummit/ship-api/testing`): `createApp({ schema: { ...accountsSchema, ...yourTables } })`. `refresh_tokens` lives in the accounts module alongside `accounts` (it FKs it), with its FK intact.

  **Module location**: modules are delivered as reference source copied into the consumer app, and now live under **`src/modules/<name>`** — both `ship-api add <module>` and the `ship-api g module|resource|service|schema|job` scaffolders target it, and the `create` template composes them from there.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish application graph validation, inspection, impact analysis, and contract
  generation as the focused `@sixthsummit/ship-cli` package. The monolithic CLI
  retains these commands through compatibility re-exports while its legacy
  scaffold and migration commands remain isolated from the new tool surface.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`c54f7d1`](https://github.com/SixthSummit/ship-api/commit/c54f7d146cfe0b316603b12e463f5cda744fbb88) Thanks [@selosindis](https://github.com/selosindis)! - A2-1 — tenancy as an opt-in primitive. Tenancy is never a core default; the framework ships the _shape_ and forces nothing.

  - **`tenantScoped(tenants)`** — new opt-in column mixin (the sibling of `baseFields`), exported from `@sixthsummit/ship-api` and `@sixthsummit/ship-api/app/db/tenantScoped`. Spread it into a domain table to add a non-null `tenant_id` uuid FK to your `tenants` root table (`onDelete: "restrict"`). It's a factory (you pass your own `tenants` table) so core references no concrete table.
  - **`resolveTenant()`** — new opt-in middleware that publishes the active tenant to `RequestContext.tenantId` (default: from the authenticated account; or a custom resolver). Convention: read the active tenant from `RequestContext.tenantId`, never `account.tenantId` directly — this keeps a future one-tenant-per-user → membership move a one-middleware change.
  - **`requireAuth` now publishes `RequestContext.userId`** from the resolved account — honoring its documented contract and fixing `createdBy` / `updatedBy` audit-stamping, which was silently always-null because the field was never set. Affects all apps, not just multi-tenant.
  - **accounts module** ships an opt-in `tenants` table + `tenantsSchema` fragment (separate from `accountsSchema`, so single-tenant apps never get a tenants table) and a commented `accounts.tenantId` example for the one-tenant-per-account model.
  - **`outbox_events.tenant_id`** reconciled from `text` to `uuid` (still nullable; the outbox carries system/global events, no FK). The generated migration is an `ALTER COLUMN ... TYPE uuid USING tenant_id::uuid` cast — **before regenerating, ensure every existing `outbox_events.tenant_id` is `NULL` or a valid UUID**; rows with non-UUID text fail the cast and must be back-filled or deleted first.

  Tenant _enforcement_ (RLS / `withTenant` auto-scoping) remains deferred to a later release; A2-1 ships the column shape + resolution convention + docs (`docs/v4/concepts/tenancy.md`).

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`cbc67a6`](https://github.com/SixthSummit/ship-api/commit/cbc67a6ed3aa5531738fd8a84c7b48d0c578c642) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `unitOfWorkDependency()` and the `@sixthsummit/ship-api/drizzle` unit-of-work adapter. Transactional operation declarations now automatically open read-only or read-write PostgreSQL scopes and inject only transaction-built capabilities.

  Compile-time graph checks reject missing, multiple, misplaced, and non-singleton unit-of-work boundaries. Nested work joins deterministically by default, read-to-write escalation is rejected, and declared or unexpected failures cross the transaction boundary before normalization so writes roll back.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`20c9de4`](https://github.com/SixthSummit/ship-api/commit/20c9de448ca11520618f62a8ff1144f2de53c042) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit typed Drizzle repository primitives without introducing a universal CRUD abstraction. Consumers can define bounded offset pagination, immutable page results, schema-specific audit and soft-delete column mappings, and closed named query projections whose arguments and results remain inferred.

### Patch Changes

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`3df355c`](https://github.com/SixthSummit/ship-api/commit/3df355c05b0991c510251cb90899290d85e7bce0) Thanks [@selosindis](https://github.com/selosindis)! - A2-8 — agent output-parity instrumentation. The `ship-api g module` / `g resource` scaffold breadcrumb now also records `tool` (the agent/editor that drove the generator) in `module.json`'s `scaffold` block, so the time-to-module delivery metric can split by tool (Claude Code vs Cursor). Claude Code auto-detects via `CLAUDECODE`; Cursor has no reliable env marker, so set `SHIP_API_SCAFFOLD_TOOL=cursor` (the override also serves CI). Metadata only — no runtime effect.

  Companion docs (not shipped in the package): the G4 **agent-parity rubric** (`docs/AGENT_PARITY_RUBRIC.md`) formalizing the manual "does a real agent session produce a working module" eval into a scored, per-tool scorecard, and a new **M6 (agent output-parity)** metric + retro tool-dimension in `docs/DELIVERY_METRICS.md`.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`a8f9d08`](https://github.com/SixthSummit/ship-api/commit/a8f9d086229709e52266cfba6eeb32e6b4aaae45) Thanks [@selosindis](https://github.com/selosindis)! - AI-A3 — `libraries/ai` is versioned independently of the framework core. Libraries are copied-in reference source, so this is a meaningful `library.json#version` recorded into the consumer + a changelog convention (not a separate npm package, which would invert the copied-in model).

  - `ship-api add -l <lib>` now stamps `src/lib/<name>/.ship-lib.json` (`{ name, version, source, at, frameworkVersion }`) from the library's `library.json`, so the vendored library version is durable in the consumer's git history — staleness is detectable and `ship-api update` has an anchor. Mirrors the `g`-scaffold provenance breadcrumb.
  - `libraries/ai` bumped `0.1.0` → `0.2.0` for the Part-II AI-R1/R2/R3 changes, independent of the framework's `4.0.0-alpha.2`; added `libraries/ai/CHANGELOG.md` + a README Versioning section.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`a7d5d04`](https://github.com/SixthSummit/ship-api/commit/a7d5d04e2b37d06baea656c18b2e0c73b9906c1c) Thanks [@selosindis](https://github.com/selosindis)! - Security-audit dependency hardening — clears both criticals and every fixable moderate from `npm audit` (27 findings → 4, all remaining in the docs-site astro chain).

  - **firebase-admin `^12.3.0` → `^13.10.0`** (core dependency + default template, moved in lockstep so consumer apps dedupe to one copy and the default-app registration stays shared). The `FirebaseAuthProvider` adapter surface (`admin.auth()`, `verifyIdToken`, `DecodedIdToken`, `admin.app.App`) is unchanged in v13; its floor is Node 18, below the framework's Node 22 engine.
  - **vitest `^3.2.4` → `^4.1.8`** (+ `@vitest/coverage-v8`) — fixes GHSA-5xrq-8626-4rwp (critical, Vitest UI arbitrary file read/execute). One v4 migration touch: `vi.fn()` now respects the implementation's constructibility, so the `Resend` mocks in `libraries/email` use `function` expressions instead of arrows. Template's vitest moves to `^4.1.8` too.
  - **@testcontainers/postgresql + localstack `^11.14.0` → `^12.0.1`** — clears the vulnerable dockerode→uuid chain in the integration-test stack.
  - **Overrides** for transitives with no upstream fix: `uuid ^11.1.1` (Google API client chains under firebase-admin/@google-cloud/storage pin uuid 8/9 — GHSA-w5hq-g745-h8pq), `esbuild ^0.25.0` under drizzle-kit's deprecated `@esbuild-kit` loader (GHSA-67mh-4wv8-2f99), and `yaml ^2.8.3` under `yaml-language-server` (GHSA-48c2-rrv3-qjmp). The template ships the uuid + esbuild overrides so scaffolded apps audit clean as well.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project the wire-input side of Zod schemas into generated contracts. Operations
  may now use defaults and transforms to normalize query, path, header, or body
  values for typed handlers without making their browser client contract
  unrepresentable. Output and error schemas remain projected from their output
  side.

- [#112](https://github.com/SixthSummit/ship-api/pull/112) [`602f54d`](https://github.com/SixthSummit/ship-api/commit/602f54d5fc64209a27c216ea0d7530b5ce2374fd) Thanks [@selosindis](https://github.com/selosindis)! - fix(cli): lazy-load the migrate-orm codemod so the CLI no longer crashes when `typescript` is not installed

  `cli/ship-api.js` statically imported `commands/migrate-orm.js`, which imports the `typescript` compiler API — but `typescript` was never a dependency of the published package. Every CLI command (including `npx @sixthsummit/ship-api create` in a fresh directory) crashed with `ERR_MODULE_NOT_FOUND` unless a hoisted `typescript` happened to be resolvable.

  The codemod is now imported inside the `migrate-orm` action handler, so `typescript` only needs to resolve when the codemod actually runs (the v3 project being migrated has it as a devDependency). If it can't resolve, the CLI prints an install hint instead of a raw module-resolution error. `typescript` is declared as an optional peer dependency to document the requirement.

- [#112](https://github.com/SixthSummit/ship-api/pull/112) [`602f54d`](https://github.com/SixthSummit/ship-api/commit/602f54d5fc64209a27c216ea0d7530b5ce2374fd) Thanks [@selosindis](https://github.com/selosindis)! - fix(cli): remove v3 relics from the CLI

  - `ship-api --help` described the stack as "Express.js, TypeORM, and Firebase"; now reflects the v4 stack (Hono + Drizzle + BullMQ + OpenTelemetry).
  - `ship-api update` no longer injects `import "reflect-metadata"` into the consumer's `src/index.ts` — a v3/TypeORM compatibility shim that would break a v4 app (`reflect-metadata` isn't a dependency, so the injected import crashed the next start).

- [#106](https://github.com/SixthSummit/ship-api/pull/106) [`c1db847`](https://github.com/SixthSummit/ship-api/commit/c1db847c083bbb9e1b95e2eb2724f7e12ee49967) Thanks [@bachellerieloic](https://github.com/bachellerieloic)! - fix(core): `createApp` no longer drops hono's default CORS `Access-Control-Allow-Methods`.

  Unset `cors` keys were forwarded into hono's `cors()` as explicit `undefined`. Because hono merges options via spread (`{ ...defaults, ...userOpts }`), an explicit `undefined` **overrides** its baked-in default rather than falling through to it. For `allowMethods` this meant preflight responses carried no `Access-Control-Allow-Methods` header, so browsers rejected every non-simple method (DELETE/PUT/PATCH) while GET/POST kept working — invisible until a consumer app issued its first browser DELETE. `createApp` now builds the hono options object by omitting unset keys, so hono's defaults survive. Same hazard fixed for `allowHeaders` / `exposeHeaders` / `maxAge` / `credentials`.

- [#102](https://github.com/SixthSummit/ship-api/pull/102) [`6210af0`](https://github.com/SixthSummit/ship-api/commit/6210af024ea8ae068fa18916ec261492d4d10b20) Thanks [@selosindis](https://github.com/selosindis)! - fix(db): set `statement_timeout` via the libpq connection `options` instead of a `pool.on("connect")` query.

  The connect-time `client.query("SET statement_timeout …")` raced the pool handing the freshly-connected client to its first caller, tripping pg's "client.query() called when the client is already executing a query" deprecation warning on consumer startup. The timeout is now applied as `-c statement_timeout=<ms>` at connection startup — same effect, no extra round-trip, no warning.

- [#102](https://github.com/SixthSummit/ship-api/pull/102) [`f620322`](https://github.com/SixthSummit/ship-api/commit/f620322172a4148dade7393607a9ae0c5eb4cef6) Thanks [@selosindis](https://github.com/selosindis)! - fix(exports): add a `default` condition to every `package.json` exports entry so CJS-based tooling can resolve framework subpaths.

  `drizzle-kit` resolves a schema file's imports through Node's CJS resolver, which only honors `require`/`default`/`node` conditions. The package declared `import`/`types` only, so any schema that imports from `@sixthsummit/ship-api` — including the **accounts module's `baseFields` import** — threw `ERR_PACKAGE_PATH_NOT_EXPORTED` under `drizzle-kit generate`/`migrate`, breaking the documented `ship-api add accounts` → `db:generate` flow.

  Each export now lists `types` → `import` → `default`, with `default` pointing at the same ESM build. It's a fallback only: ESM consumers and edge bundlers still match `import`, TypeScript still matches `types` — only CJS-context resolvers (drizzle-kit) gain a resolvable path, then bundle the ESM via esbuild. No new CJS runtime entry point is introduced; the package stays ESM-only.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`d42f7ea`](https://github.com/SixthSummit/ship-api/commit/d42f7ea2a3d6686387bfab2735fe3c399d5a21fb) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the generated application's OpenTelemetry startup order. The scaffold now
  starts the extracted SDK from an isolated instrumentation boundary before it
  dynamically imports the HTTP application, so ESM cannot load HTTP, database,
  Redis, or logging dependencies before auto-instrumentation is installed.

- [#104](https://github.com/SixthSummit/ship-api/pull/104) [`82d46ab`](https://github.com/SixthSummit/ship-api/commit/82d46ab498e9adeb83e6d23b261608ec36c73f5e) Thanks [@selosindis](https://github.com/selosindis)! - Fix the typed-client contract: route definers are now generic over Hono's schema parameter (`defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps)`), so chaining multiple modules accumulates route types instead of each module wiping out the previous one's. The non-generic `app: Hono<AppEnv>` signature widened an already-chained app — `hc<ShipApiClient>()` consumers got a client that typed zero routes.

  Also fixed everywhere the broken shape was taught or scaffolded: the template `index.ts` now captures the chained return and exports `ShipApiClient` from the end of the chain, the `g module` generator emits the schema-generic signature, and docs/rules/skills show the correct pattern. A tsc-enforced type assertion (`modules/typed-client.typecheck.ts`) now fails `type-check` if any definer signature regresses.

  If you scaffolded an app or generated modules from an earlier alpha: change your route definers to the schema-generic signature, capture each `defineXxxRoutes(...)` return, chain modules off the previous return, and point `export type ShipApiClient` at the final capture.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`16d1536`](https://github.com/SixthSummit/ship-api/commit/16d1536367e45d296395567ef888c339e17b0d07) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Upgrade the OpenTelemetry runtime to the patched 0.222/2.11 release line and verify SDK startup, span export, and pino trace correlation with a real-process regression test.

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial v4 alpha — a TypeScript backend framework on Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry, designed to be edited by AI coding agents.

  - **Core**: `createApp<TSchema>` Hono factory with route-registry capture, `DrizzleEntityService` (generic CRUD/list/search + lifecycle hooks), the neutral `QueryOptions` operator DSL, and the `baseFields` audit-column mixin.
  - **Auth & access**: pluggable `AuthProvider` (with a `FirebaseAuthProvider` adapter), an ES256 JWT signer with refresh-token rotation, and `requireAuth` / `requirePermission` / `apiKey` / `rateLimit` / `idempotency` / `csrf` middleware.
  - **HTTP**: the AppError taxonomy with uniform error shaping, the `validate()` zValidator wrapper, SSE + `streamLLM` streaming, `@hono/node-ws` WebSockets with subprotocol auth, upload + webhook parsers, and `/livez` + `/readyz` health checks.
  - **Infrastructure**: BullMQ `defineJob` / `defineCron`, a transactional `outbox`, a Redis cache with tag invalidation, S3 / Disk / GCS storage adapters, and pino + OpenTelemetry observability with a Prometheus exporter.
  - **Consumer surface**: a typed `hc()` client subpath (no codegen), the `ship-api create` / `dev` / `g` CLI, the `migrate-orm` TypeORM→Drizzle codemod, and three reference modules (`accounts`, `oauth`, `outbox`).
  - **Agent tooling**: a bundled Claude Code plugin and MCP server (`list_routes` / `describe_route` / `find_route_collisions` / `execute_route`).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`8c182e5`](https://github.com/SixthSummit/ship-api/commit/8c182e5cdafbac99f3a670259dbbe9ccbfadf11f) Thanks [@selosindis](https://github.com/selosindis)! - Module + library tests now run in `npm test` / CI via the root vitest config, instead of the core workspace only. Wiring them in surfaced — and fixed — pre-existing breakage that had been silently un-run: `libraries/chunking` (the repo never installed its manifest-declared `tiktoken`) and `libraries/email`.

  `EmailService` no longer imports the host app's `environment` module. Config (`apiKey`, `defaultFrom`) is passed via the constructor — which it already accepted — and the implicit env fallback is removed, so `new EmailService()` with no args now throws. Pass values from your validated env instead: `new EmailService(env.RESEND_API_KEY, env.RESEND_DEFAULT_FROM)`. This decouples the library from the consumer app's file structure (it was the only library reaching up into the host's `../../environment.js`).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`acbfb2e`](https://github.com/SixthSummit/ship-api/commit/acbfb2e07491a5801059373691572df1909e9d82) Thanks [@selosindis](https://github.com/selosindis)! - `ship-api g module` / `g resource` now stamp scaffold provenance into the generated `module.json` — a `scaffold` block recording the `generator`, module `name`, ISO `at` timestamp, and `frameworkVersion`. This is the un-backfillable start-point breadcrumb for the "time-to-module" delivery metric (see `docs/DELIVERY_METRICS.md`): it rides into git as part of the module, so it survives rebases/squashes and needs no commit-message discipline. No effect on a module's runtime behavior; the field is metadata only.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the browser-safe operation client, JSON contract manifest, backend application types, schema projection, and OpenAPI projection as `@sixthsummit/ship-contract`. The monolithic contract subpaths become deprecated compatibility re-exports.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish transaction execution, repository primitives, named projections, and tenant-scoped repository factories as `@sixthsummit/ship-drizzle`. The monolithic Drizzle entry becomes a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the Hono transport, credential extraction, and HTTP error projection as `@sixthsummit/ship-hono`. Keep the former `@sixthsummit/ship-api/hono` entry as a deprecated compatibility re-export, with the legacy v4 auth-provider bridge confined to the monolithic package.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the transport- and infrastructure-independent operation kernel as `@sixthsummit/ship-core`. Keep the former `@sixthsummit/ship-api/kernel` path as a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish tracing helpers, OpenTelemetry SDK lifecycle, and Prometheus metrics on explicit `@sixthsummit/ship-observability-otel` entrypoints. The monolithic observability paths become deprecated compatibility re-exports.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish behavioral parity utilities and the real PostgreSQL Testcontainers harness as the development-only `@sixthsummit/ship-testing` trust zone. The monolithic testing entry becomes an optional compatibility re-export.

- [#111](https://github.com/SixthSummit/ship-api/pull/111) [`1baa8f7`](https://github.com/SixthSummit/ship-api/commit/1baa8f72b6b58f081a69d42332f714f576dadf08) Thanks [@selosindis](https://github.com/selosindis)! - Fix stale db/auth wiring references in the scaffolded reference app (`ship-api create`). The schema is consumed by `createDb({ config, schema })` (not `createApp({ schema })` — `createApp` takes no `schema`); `createDb` imports from `@sixthsummit/ship-api/app/db/client`; and the `firebaseAuth` example uses its real `findAccount` option (not a non-existent `credentialsJson`). The wiring example now mirrors the canonical pattern (compose `db` via `createDb`, then `root.route("/", buildXxxApp(deps))`).

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Type authenticated and permission-gated operation handler contexts with a
  required actor, matching the executor's existing access-before-handler runtime
  guarantee. Public handlers continue to receive an optional actor.
- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`1f79ef5`](https://github.com/SixthSummit/ship-api/commit/1f79ef50dc80dbdced33f031a286542d253100b2), [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`fec66de`](https://github.com/SixthSummit/ship-api/commit/fec66de7e605748c4c80269de40cf092730c5b6a), [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`7c57c0f`](https://github.com/SixthSummit/ship-api/commit/7c57c0f32f80dbac97ae842dcc80e1cb1f527440), [`8de94e0`](https://github.com/SixthSummit/ship-api/commit/8de94e0bf393b25e351a4a0f565723be440d7b5f), [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d), [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7), [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0), [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d), [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b), [`d3ce43b`](https://github.com/SixthSummit/ship-api/commit/d3ce43bec75dcdbfc316db341459735f48aa37ab), [`b60621d`](https://github.com/SixthSummit/ship-api/commit/b60621d0f1d0daf4e975ca42bd6c65e6967dcfb5), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@1.0.0
  - @sixthsummit/ship-contract@1.0.0
  - @sixthsummit/ship-hono@1.0.0
  - @sixthsummit/ship-cli@1.0.0
  - @sixthsummit/ship-drizzle@1.0.0
  - @sixthsummit/ship-testing@1.0.0
  - @sixthsummit/ship-observability-otel@1.0.0

## 4.0.0-alpha.7

### Minor Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept lowercase dot-namespaced permission slugs as well as colon-namespaced
  slugs so applications can preserve established RBAC catalogs during migration.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`98b5dab`](https://github.com/SixthSummit/ship-api/commit/98b5dab6b19f056a2726760cf73b3e855d937b31) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add authorization-backed tenant capabilities and transaction-scoped tenant repository factories. Tenant repositories now require nominal scope evidence, privileged repository surfaces require a distinct bypass, and bypass issuance and use fail closed unless synchronously audited.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare bounded JSON, raw, and multipart request-body modes on HTTP operations. Enforce authentication and access before body reads, stop streamed reads at the total byte limit, project policies into manifests and OpenAPI, and teach generated clients to preserve raw bytes and Fetch-owned multipart boundaries.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`5e456fd`](https://github.com/SixthSummit/ship-api/commit/5e456fdb93c972b35218f58e3f61f81cdc20daf3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add deterministic application graph commands for validation, inspection, impact queries, and `.ship/graph.json` emission from TypeScript app declarations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit immediate external-effect capabilities and operation declarations.
  The application compiler now rejects undisclosed, unbound, transitively hidden,
  or transactionally unsafe effects, and projects valid effects into the stable
  application graph for inspection and impact analysis.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`51f86e4`](https://github.com/SixthSummit/ship-api/commit/51f86e44329a27918235c15c81f8654794a1719f) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add canonical `http.get/post/put/patch/delete/options` declarations and `createHonoAdapter`, deriving Hono routes directly from compiled operations. The adapter translates path, query, header, and JSON body input, then delegates validation, access, providers, errors, and result checks to the transport-independent executor.

  Expose explicit `@sixthsummit/ship-api/kernel` and `@sixthsummit/ship-api/hono` subpaths so edge consumers can import the supported runtime seam without loading Node-only framework services.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`bbb27a1`](https://github.com/SixthSummit/ship-api/commit/bbb27a12e24ddcf9c63e8367acf32de6ed8eb779) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit JSON, text, and binary operation response modes with deterministic content types and safe application response headers.

  Stabilize the HTTP failure contract, including validation issue details, strict and bounded JSON parsing, `413`/`415` failures, request correlation, and an unexpected-error observer that cannot leak through the wire response.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`2e8e4c7`](https://github.com/SixthSummit/ship-api/commit/2e8e4c7e268160f21edd6e7049572754d2355d57) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `defineApp`/`compileApp` to validate explicit modules as one application graph. Compilation rejects duplicate operations/providers/transports, missing or private dependencies, undeclared imports, ownership mismatches, and module/provider cycles with stable structured diagnostics.

  Compiled applications expose immutable typed lookups and a deterministic, serializable graph projection for future CLI, client, OpenAPI, and impact tooling.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`03511eb`](https://github.com/SixthSummit/ship-api/commit/03511ebc8025571073a90efe377745c8b406fa14) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add transport-independent operation execution with `createExecutor`. The executor authoritatively enforces access, validates and transforms input, resolves scoped dependency graphs, validates output/error details, preserves request identity and cancellation, and returns discriminated success or declared-failure values.

  Add reusable `operationError` definitions and `operationFailure` so error codes, statuses, safe messages, and detail schemas are graph-visible. Undeclared failures, invalid handler output, schema crashes, and provider failures produce stable exceptional diagnostics instead of leaking as expected API errors.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`22efa4c`](https://github.com/SixthSummit/ship-api/commit/22efa4c0b7a41891ff4fa0682b1f894cd1c82f43) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add immutable `defineModule`, `defineProvider`, and `valueProvider` declarations to the application kernel. Modules explicitly list operations, providers, imports, and exported capabilities; provider factories receive only their typed declared dependencies and choose singleton or operation lifetime.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f588e49`](https://github.com/SixthSummit/ship-api/commit/f588e4909ed86c772ea377fb5d3c1167a8da47d3) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the first agent-native kernel contract: `defineOperation` creates immutable, runtime-validated operation declarations with Standard Schema input/output inference, explicit access and transaction modes, stable error codes, typed dependencies, and optional transport metadata.

  Handlers return the default success body directly or use `respond(status, body)` for an alternate declared success. This is additive beside the existing v4 Hono APIs while the compiled graph and adapters are built and proven.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Model optional verified identities separately from application actors. This
  lets onboarding and profile routes distinguish missing credentials from valid
  identities that do not yet have an application account, without manufacturing
  a domain actor or weakening protected operations.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f83fc6c`](https://github.com/SixthSummit/ship-api/commit/f83fc6c76c38ac8fbf1a1d1ba39286de361e9269) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add transport-independent actor resolvers, immutable per-invocation permission snapshots, and explicit Hono credential adapters. Generated HTTP routes now resolve actors and reject unauthorized requests before body parsing while the operation executor remains the authoritative access boundary.

  Add `honoAuthProvider()` as a migration bridge for existing v4 `AuthProvider` implementations, with stable 401, 403, and 503 authentication outcomes.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`baead03`](https://github.com/SixthSummit/ship-api/commit/baead0331d7370d77add9c9fa1e6685291990937) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project deterministic client and OpenAPI contracts from compiled operations. Add a browser-safe structural operation client with typed operation IDs, inputs, success/error values, codecs, response metadata, JSON/text/binary representations, stable protocol diagnostics, and unambiguous query-array serialization.

  Add `ship-api contract` to emit fingerprinted `.ship/contract.json` and `.ship/openapi.json` artifacts. Application error declarations can no longer reuse framework-owned validation, authentication, authorization, payload, media, internal, or authentication-availability codes.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish application graph validation, inspection, impact analysis, and contract
  generation as the focused `@sixthsummit/ship-cli` package. The monolithic CLI
  retains these commands through compatibility re-exports while its legacy
  scaffold and migration commands remain isolated from the new tool surface.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`cbc67a6`](https://github.com/SixthSummit/ship-api/commit/cbc67a6ed3aa5531738fd8a84c7b48d0c578c642) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add `unitOfWorkDependency()` and the `@sixthsummit/ship-api/drizzle` unit-of-work adapter. Transactional operation declarations now automatically open read-only or read-write PostgreSQL scopes and inject only transaction-built capabilities.

  Compile-time graph checks reject missing, multiple, misplaced, and non-singleton unit-of-work boundaries. Nested work joins deterministically by default, read-to-write escalation is rejected, and declared or unexpected failures cross the transaction boundary before normalization so writes roll back.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`20c9de4`](https://github.com/SixthSummit/ship-api/commit/20c9de448ca11520618f62a8ff1144f2de53c042) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add explicit typed Drizzle repository primitives without introducing a universal CRUD abstraction. Consumers can define bounded offset pagination, immutable page results, schema-specific audit and soft-delete column mappings, and closed named query projections whose arguments and results remain inferred.

### Patch Changes

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Project the wire-input side of Zod schemas into generated contracts. Operations
  may now use defaults and transforms to normalize query, path, header, or body
  values for typed handlers without making their browser client contract
  unrepresentable. Output and error schemas remain projected from their output
  side.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`d42f7ea`](https://github.com/SixthSummit/ship-api/commit/d42f7ea2a3d6686387bfab2735fe3c399d5a21fb) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the generated application's OpenTelemetry startup order. The scaffold now
  starts the extracted SDK from an isolated instrumentation boundary before it
  dynamically imports the HTTP application, so ESM cannot load HTTP, database,
  Redis, or logging dependencies before auto-instrumentation is installed.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate a browser-safe TypeScript operation contract beside the deterministic JSON and OpenAPI artifacts. The generated `AppContract` derives exact operation IDs, input locations, response bodies, statuses, and declared errors from the literal manifest without importing a Hono app or server package.

  Add the zero-runtime `ClientTypeContract` projection so application contract packages can expose compile-time types directly from their generated JSON Schemas.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`16d1536`](https://github.com/SixthSummit/ship-api/commit/16d1536367e45d296395567ef888c339e17b0d07) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Upgrade the OpenTelemetry runtime to the patched 0.222/2.11 release line and verify SDK startup, span export, and pino trace correlation with a real-process regression test.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the browser-safe operation client, JSON contract manifest, backend application types, schema projection, and OpenAPI projection as `@sixthsummit/ship-contract`. The monolithic contract subpaths become deprecated compatibility re-exports.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish transaction execution, repository primitives, named projections, and tenant-scoped repository factories as `@sixthsummit/ship-drizzle`. The monolithic Drizzle entry becomes a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the Hono transport, credential extraction, and HTTP error projection as `@sixthsummit/ship-hono`. Keep the former `@sixthsummit/ship-api/hono` entry as a deprecated compatibility re-export, with the legacy v4 auth-provider bridge confined to the monolithic package.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish the transport- and infrastructure-independent operation kernel as `@sixthsummit/ship-core`. Keep the former `@sixthsummit/ship-api/kernel` path as a deprecated compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish tracing helpers, OpenTelemetry SDK lifecycle, and Prometheus metrics on explicit `@sixthsummit/ship-observability-otel` entrypoints. The monolithic observability paths become deprecated compatibility re-exports.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Publish behavioral parity utilities and the real PostgreSQL Testcontainers harness as the development-only `@sixthsummit/ship-testing` trust zone. The monolithic testing entry becomes an optional compatibility re-export.

- [#114](https://github.com/SixthSummit/ship-api/pull/114) [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Type authenticated and permission-gated operation handler contexts with a
  required actor, matching the executor's existing access-before-handler runtime
  guarantee. Public handlers continue to receive an optional actor.
- Updated dependencies [[`347848b`](https://github.com/SixthSummit/ship-api/commit/347848bcdb6236e78f59297616610985cfcdcc01), [`591a641`](https://github.com/SixthSummit/ship-api/commit/591a6412ccd719e7eb9fca7a57b3410179e3c7c1), [`1f79ef5`](https://github.com/SixthSummit/ship-api/commit/1f79ef50dc80dbdced33f031a286542d253100b2), [`acd3368`](https://github.com/SixthSummit/ship-api/commit/acd33684269b32dda86bdde0e5ccfcf157e1a7aa), [`b9a1d53`](https://github.com/SixthSummit/ship-api/commit/b9a1d53d2b537db62d965bde481c14dc84118c9e), [`3f1fcff`](https://github.com/SixthSummit/ship-api/commit/3f1fcff1ea635897ba12b62ba5f6a8848ac76604), [`fec66de`](https://github.com/SixthSummit/ship-api/commit/fec66de7e605748c4c80269de40cf092730c5b6a), [`3defe3b`](https://github.com/SixthSummit/ship-api/commit/3defe3b95acaeb4d9c0790a28d4570ebf5d58395), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`88df200`](https://github.com/SixthSummit/ship-api/commit/88df200140b339a44010f1666832d3d64a263e2c), [`baf4a45`](https://github.com/SixthSummit/ship-api/commit/baf4a45a253de1d61c422a01b0e1f592a6bec9b5), [`7c57c0f`](https://github.com/SixthSummit/ship-api/commit/7c57c0f32f80dbac97ae842dcc80e1cb1f527440), [`8de94e0`](https://github.com/SixthSummit/ship-api/commit/8de94e0bf393b25e351a4a0f565723be440d7b5f), [`b22cffb`](https://github.com/SixthSummit/ship-api/commit/b22cffbf1c9d066f317cdf3e492acb0567e9b36d), [`26f9887`](https://github.com/SixthSummit/ship-api/commit/26f988707a3202a8146adf3528232d73260c9dd7), [`f0f44f2`](https://github.com/SixthSummit/ship-api/commit/f0f44f2adb3ac93eb5313d7d7a93d1419a05cdc0), [`862daa4`](https://github.com/SixthSummit/ship-api/commit/862daa4f42557d6dab7ca0b5783fc54ba07d1faa), [`4c8da21`](https://github.com/SixthSummit/ship-api/commit/4c8da21b720f5625188a6a01f8d82932f158aadf), [`899011d`](https://github.com/SixthSummit/ship-api/commit/899011d2aa0d671fc5b5f8d6201260ef61bbaa3d), [`a618479`](https://github.com/SixthSummit/ship-api/commit/a618479105d54dcabeab2271dc555dcb1176740b), [`d3ce43b`](https://github.com/SixthSummit/ship-api/commit/d3ce43bec75dcdbfc316db341459735f48aa37ab), [`47a4985`](https://github.com/SixthSummit/ship-api/commit/47a49859a10c2fb13cb93dfcffef6abc81d09cad)]:
  - @sixthsummit/ship-core@0.1.0-alpha.1
  - @sixthsummit/ship-contract@0.1.0-alpha.1
  - @sixthsummit/ship-hono@0.1.0-alpha.1
  - @sixthsummit/ship-cli@0.1.0-alpha.1
  - @sixthsummit/ship-drizzle@0.1.0-alpha.1
  - @sixthsummit/ship-testing@0.1.0-alpha.1
  - @sixthsummit/ship-observability-otel@0.1.0-alpha.1

## 4.0.0-alpha.6

### Patch Changes

- [#112](https://github.com/SixthSummit/ship-api/pull/112) [`602f54d`](https://github.com/SixthSummit/ship-api/commit/602f54d5fc64209a27c216ea0d7530b5ce2374fd) Thanks [@selosindis](https://github.com/selosindis)! - fix(cli): lazy-load the migrate-orm codemod so the CLI no longer crashes when `typescript` is not installed

  `cli/ship-api.js` statically imported `commands/migrate-orm.js`, which imports the `typescript` compiler API — but `typescript` was never a dependency of the published package. Every CLI command (including `npx @sixthsummit/ship-api create` in a fresh directory) crashed with `ERR_MODULE_NOT_FOUND` unless a hoisted `typescript` happened to be resolvable.

  The codemod is now imported inside the `migrate-orm` action handler, so `typescript` only needs to resolve when the codemod actually runs (the v3 project being migrated has it as a devDependency). If it can't resolve, the CLI prints an install hint instead of a raw module-resolution error. `typescript` is declared as an optional peer dependency to document the requirement.

- [#112](https://github.com/SixthSummit/ship-api/pull/112) [`602f54d`](https://github.com/SixthSummit/ship-api/commit/602f54d5fc64209a27c216ea0d7530b5ce2374fd) Thanks [@selosindis](https://github.com/selosindis)! - fix(cli): remove v3 relics from the CLI
  - `ship-api --help` described the stack as "Express.js, TypeORM, and Firebase"; now reflects the v4 stack (Hono + Drizzle + BullMQ + OpenTelemetry).
  - `ship-api update` no longer injects `import "reflect-metadata"` into the consumer's `src/index.ts` — a v3/TypeORM compatibility shim that would break a v4 app (`reflect-metadata` isn't a dependency, so the injected import crashed the next start).

## 4.0.0-alpha.5

### Minor Changes

- [#108](https://github.com/SixthSummit/ship-api/pull/108) [`fc89bcc`](https://github.com/SixthSummit/ship-api/commit/fc89bccb69567b0dcfcb4bf6d8a7cc54a69505cb) Thanks [@selosindis](https://github.com/selosindis)! - Scale the typed `hc()` client to many modules: mount module sub-apps at the root instead of chaining onto one app.

  Composing every module's routes onto a single Hono app accumulates one giant route-type that overflows `tsc` (TS2589 / "instantiation excessively deep", or a hard `RangeError` in the type checker) once an app has enough modules — collapsing the typed client to `never` on consumers. v4 now composes modules as **independent sub-apps mounted at the root**, which keeps each route-type instantiation bounded and lets the typed client scale ~4× further, with **no change to the client shape** (routes keep their absolute paths, so `api.accounts.$get` is unchanged) and no codegen.

  New:

  - `createModuleApp(name)` — a CORS-less `createApp` sibling for building a module sub-app. Tags every captured route with its module, lighting up the Module column in `/dev/routes` and the `module` filter in `list_routes`. Fails fast (throws at dev time) if a sub-app sets `onError` / `notFound` / global `use("*")` — those cross-cutting concerns belong on the root, and silently shadowing them is the one real footgun of the sub-app model.
  - `buildAccountsApp` / `buildOAuthApp` / `buildOutboxApp` — each reference module now exposes a builder returning its own sub-app.
  - `ShipApiSuccessClient<App>` — a success-only (`200 | 201`) client type via Hono's `PickResponseByStatusCode`, for apps that handle errors centrally (the default, via `registerErrorHandlers`).
  - The scaffold (`ship-api g module|resource`) emits the new `buildXxxApp` + `root.route("/", ...)` wiring; the app template emits declarations + a materialized `hcWithType` client for cheaper cross-package typing.

  **Breaking (composition only):** wire modules with `const app = root.route("/", buildXxxApp(deps))` and point `ShipApiClient` at the result, instead of threading one app through `defineXxxRoutes(app, deps)`. `defineXxxRoutes(app, deps)` is retained for advanced composition but is now flagged as a scaling foot-gun. Keep `registerErrorHandlers` + `httpLogger` + cors on the **root only** — never on a module sub-app (a sub-app `onError` would shadow the uniform AppError shape).

### Patch Changes

- [#106](https://github.com/SixthSummit/ship-api/pull/106) [`c1db847`](https://github.com/SixthSummit/ship-api/commit/c1db847c083bbb9e1b95e2eb2724f7e12ee49967) Thanks [@bachellerieloic](https://github.com/bachellerieloic)! - fix(core): `createApp` no longer drops hono's default CORS `Access-Control-Allow-Methods`.

  Unset `cors` keys were forwarded into hono's `cors()` as explicit `undefined`. Because hono merges options via spread (`{ ...defaults, ...userOpts }`), an explicit `undefined` **overrides** its baked-in default rather than falling through to it. For `allowMethods` this meant preflight responses carried no `Access-Control-Allow-Methods` header, so browsers rejected every non-simple method (DELETE/PUT/PATCH) while GET/POST kept working — invisible until a consumer app issued its first browser DELETE. `createApp` now builds the hono options object by omitting unset keys, so hono's defaults survive. Same hazard fixed for `allowHeaders` / `exposeHeaders` / `maxAge` / `credentials`.

- [#111](https://github.com/SixthSummit/ship-api/pull/111) [`1baa8f7`](https://github.com/SixthSummit/ship-api/commit/1baa8f72b6b58f081a69d42332f714f576dadf08) Thanks [@selosindis](https://github.com/selosindis)! - Fix stale db/auth wiring references in the scaffolded reference app (`ship-api create`). The schema is consumed by `createDb({ config, schema })` (not `createApp({ schema })` — `createApp` takes no `schema`); `createDb` imports from `@sixthsummit/ship-api/app/db/client`; and the `firebaseAuth` example uses its real `findAccount` option (not a non-existent `credentialsJson`). The wiring example now mirrors the canonical pattern (compose `db` via `createDb`, then `root.route("/", buildXxxApp(deps))`).

## 4.0.0-alpha.4

### Patch Changes

- [#102](https://github.com/SixthSummit/ship-api/pull/102) [`6210af0`](https://github.com/SixthSummit/ship-api/commit/6210af024ea8ae068fa18916ec261492d4d10b20) Thanks [@selosindis](https://github.com/selosindis)! - fix(db): set `statement_timeout` via the libpq connection `options` instead of a `pool.on("connect")` query.

  The connect-time `client.query("SET statement_timeout …")` raced the pool handing the freshly-connected client to its first caller, tripping pg's "client.query() called when the client is already executing a query" deprecation warning on consumer startup. The timeout is now applied as `-c statement_timeout=<ms>` at connection startup — same effect, no extra round-trip, no warning.

- [#102](https://github.com/SixthSummit/ship-api/pull/102) [`f620322`](https://github.com/SixthSummit/ship-api/commit/f620322172a4148dade7393607a9ae0c5eb4cef6) Thanks [@selosindis](https://github.com/selosindis)! - fix(exports): add a `default` condition to every `package.json` exports entry so CJS-based tooling can resolve framework subpaths.

  `drizzle-kit` resolves a schema file's imports through Node's CJS resolver, which only honors `require`/`default`/`node` conditions. The package declared `import`/`types` only, so any schema that imports from `@sixthsummit/ship-api` — including the **accounts module's `baseFields` import** — threw `ERR_PACKAGE_PATH_NOT_EXPORTED` under `drizzle-kit generate`/`migrate`, breaking the documented `ship-api add accounts` → `db:generate` flow.

  Each export now lists `types` → `import` → `default`, with `default` pointing at the same ESM build. It's a fallback only: ESM consumers and edge bundlers still match `import`, TypeScript still matches `types` — only CJS-context resolvers (drizzle-kit) gain a resolvable path, then bundle the ESM via esbuild. No new CJS runtime entry point is introduced; the package stays ESM-only.

- [#104](https://github.com/SixthSummit/ship-api/pull/104) [`82d46ab`](https://github.com/SixthSummit/ship-api/commit/82d46ab498e9adeb83e6d23b261608ec36c73f5e) Thanks [@selosindis](https://github.com/selosindis)! - Fix the typed-client contract: route definers are now generic over Hono's schema parameter (`defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps)`), so chaining multiple modules accumulates route types instead of each module wiping out the previous one's. The non-generic `app: Hono<AppEnv>` signature widened an already-chained app — `hc<ShipApiClient>()` consumers got a client that typed zero routes.

  Also fixed everywhere the broken shape was taught or scaffolded: the template `index.ts` now captures the chained return and exports `ShipApiClient` from the end of the chain, the `g module` generator emits the schema-generic signature, and docs/rules/skills show the correct pattern. A tsc-enforced type assertion (`modules/typed-client.typecheck.ts`) now fails `type-check` if any definer signature regresses.

  If you scaffolded an app or generated modules from an earlier alpha: change your route definers to the schema-generic signature, capture each `defineXxxRoutes(...)` return, chain modules off the previous return, and point `export type ShipApiClient` at the final capture.

## 4.0.0-alpha.3

### Minor Changes

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`f5b0828`](https://github.com/SixthSummit/ship-api/commit/f5b082809dc13cf27ace9479ce6f7dc68ce179f0) Thanks [@selosindis](https://github.com/selosindis)! - A2-7 — Drizzle hedge lint guard. An ESLint rule (`@typescript-eslint/no-restricted-imports`) that keeps raw Drizzle query operators (`eq`/`and`/`sql`/…) in the data-access layer, so `QueryOptions` stays a real ORM-swap seam instead of an eroding convention.

  - **Scaffolded apps enforce it:** the default template's ESLint config flags a raw `drizzle-orm` value import in any `src/modules/**/services/**` (or route/handler) file; `src/db` + module `schema.ts` are exempt, and type-only imports (`InferSelectModel`, …) are allowed. For specialized access (row locking, raw `sql`) the rule message points at a justified `// eslint-disable-next-line … -- <reason>`.
  - **Closes the subpath bypass:** the operators also re-export from `drizzle-orm/sql`, `…/sql/expressions`, `…/pg-core/expressions`, so the rule blocks those patterns too — `import { eq } from "drizzle-orm/sql"` can't dodge it. `drizzle-orm/pg-core` schema columns stay free.
  - **Bites in-repo too:** the framework now lints `modules/**` (previously ESLint-ignored), so the guard applies to the reference modules; the outbox + oauth services carry a justified `eslint-disable` (the outbox drainer needs row locking + atomic `sql`), which also keeps `ship-api add outbox/oauth` clean under the template rule.
  - Convention documented in `typescript.mdc` + both AGENTS.md. Ceiling: import-free raw access via the `protected db` (`db.query`/`db.select`) is enforced by review, not lint. Adversarially reviewed (2 blockers fixed).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`7f66aca`](https://github.com/SixthSummit/ship-api/commit/7f66aca7d91e5a66d7e264cf7f72ccbc9deae388) Thanks [@selosindis](https://github.com/selosindis)! - AI-R1 — the `libraries/ai` provider seam is now genuinely **pass-through**, not lowest-common-denominator. The seam already accepted `providerOptions` inbound but discarded native features outbound; this completes the round-trip so multi-provider apps keep the native capabilities they paid the provider for.

  - `CompleteResult` and `StreamStopEvent` gain an optional `raw` (untranslated provider response) + `providerExtras`; `TokenUsage` gains `reasoningTokens` + `raw`. All additive-optional (non-breaking).
  - Both adapters now populate them: Anthropic surfaces dropped blocks (thinking / citations / server-tool-use) via `providerExtras.blocks` + the full `raw`; OpenAI surfaces `refusal` + reasoning-token accounting + `raw`.
  - **Bug fix:** `agentLoop` and `retrieveAndAnswer` silently dropped `providerOptions` / `metadata` — they now forward them, so prompt caching / extended thinking can actually be enabled through those entry points.

  (An optional native-`completeStructured` provider method is a non-speculative follow-on — `providerOptions` already lets native structured output pass through `completeStructured` today.)

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`611886a`](https://github.com/SixthSummit/ship-api/commit/611886a3fb07991c4f0f8b19221464723b112b8b) Thanks [@selosindis](https://github.com/selosindis)! - AI-R2 + AI-R3 — thin the two most volatile `libraries/ai` surfaces (alpha-window breaking, deliberate).

  **AI-R2 — `agentLoop` is no longer on the stable surface.** The hand-rolled model→tool→model loop is the piece most likely superseded by MCP / provider-native agent runtimes, so it now lives at `@sixthsummit/ship-api/libraries/ai/experimental` (no stability promise, `@experimental`). **BREAKING:** import `agentLoop` / `collectAssistantText` / `AgentLoopError` / `AgentLoopMaxIterationsError` and its types from the `/experimental` subpath instead of the barrel. The `defineTool` / `toolRegistry` building blocks stay on the stable barrel.

  **AI-R3 — heuristic token counting is deprecated.** `HeuristicTokenizer` and `countMessageTokens` are `@deprecated` (kept exported): token _truth_ is the real usage on the provider response (`CompleteResult.usage` / `StreamStopEvent.usage`, surfaced richer by AI-R1). New thin `estimateTokens` / `estimateMessageTokens` helpers cover the legitimate pre-call prompt-fit / rate-limit-gating use-case, honestly labelled as estimates. The pluggable `Tokenizer` interface is unchanged — a real tiktoken/claude tokenizer still implements it.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`65c2dc4`](https://github.com/SixthSummit/ship-api/commit/65c2dc4b0f4f9705dbddc0add21706aeccb8f7e5) Thanks [@selosindis](https://github.com/selosindis)! - A2-2 — contract freeze pass (+ A2-3). Locks the public surface apps code and migrate against, documented in `docs/PUBLIC_API_SURFACE.md`: the three export-path stability tiers (`@sixthsummit/ship-api` barrel + `/client` are semver-locked; `/*` deep paths are not), the barrel exports, the column primitives + accounts table shapes, the error-response envelope + code/status mapping, the `module.json` shape, the permission-slug convention, and the `hc()` cross-framework seam.

  - **A2-3 — `QueryFilter` collision resolved.** The query-DSL type in `@sixthsummit/ship-api/app/db/QueryOptions` is renamed `DslQueryFilter`; the lifecycle-hook `QueryFilter` keeps the name and remains the barrel export. Internal rename; consumers importing the DSL type from that deep path update `QueryFilter` → `DslQueryFilter` (deep paths are not semver-locked).
  - **Barrel consistency:** every configurable middleware now exports its `Options` type — `ApiKeyOptions`, `CsrfOptions`, `RateLimitOptions`, `IdempotencyOptions` — alongside the existing `RequireAuthOptions`/`HttpLoggerOptions`. Additive.
  - **`PermissionDefinition`** (`{ slug, label }`) is barrel-exported — the locked permission-seeding shape; each module's `*_PERMISSION_DEFINITIONS` is pinned to it via `satisfies`.
  - Fixed the stale `defaultSchema` reference in the `g module` `module.json` template (→ `accountsSchema`).

  The barrel audit found no incidental exports to trim — it was already minimal and intentional.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`fe2dd84`](https://github.com/SixthSummit/ship-api/commit/fe2dd849c8b33cad933a84e028bdef63c65827cc) Thanks [@selosindis](https://github.com/selosindis)! - A2-6 — v3↔v4 behavioral-parity harness (started). A differential harness that pins v4's observable behavior against v3's — error envelopes, auth edge cases, pagination/validation/query semantics — to capture the "wasting-asset" parity oracle while running v3 apps still exist (the codemod proved structural migration; this proves behavioral parity).

  - Ships `runParityFixture()` + `parseParityFixtures()` + the JSONL fixture format from `@sixthsummit/ship-api/testing`, so a migrated app runs its captured v3 fixtures against its v4 build — in-process via Hono `app.request()`, no Docker.
  - New `npm run test:parity` gate (`vitest.parity.config.ts`); `*.parity.test.ts` is excluded from the unit run.
  - Seeds `v4-conformance` fixtures that lock the documented error-response envelope + the auth-401 contract today — proving the harness and guarding v4 against regressing its own contract.
  - Capture procedure + rationale in `docs/v4/tooling/parity-harness.md`.

  Capturing real `v3-capture` fixtures from a live v3 app is the maintainer's step (there is no v3 app in this repo).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`4c598d9`](https://github.com/SixthSummit/ship-api/commit/4c598d9ae378614b1d99a77464c71d5641909dc8) Thanks [@selosindis](https://github.com/selosindis)! - Identity + RBAC schema (`accounts`, `roles`, `permissions`, `role_permissions`, `refresh_tokens`) has moved out of framework core (`@sixthsummit/ship-api/app/schema`) into the `accounts` module, so the framework stays incrementally adoptable — each app owns and tailors its own identity model. Core now ships **zero concrete tables** — only the primitives: `baseFields`, the `AuthProvider` interface, `DrizzleEntityService`, and the JWT-auth machinery (`JwtSigner`, the `RefreshTokenStore` interface, the generic `DrizzleRefreshTokenStore`, and `AuthFlow`), which receive the concrete `refresh_tokens` table via DI.

  **BREAKING**: import `accounts` / `roles` / `permissions` / `refresh_tokens` from the accounts module, not from `@sixthsummit/ship-api/app/schema` — that subpath and the `defaultSchema` / `DefaultSchema` exports have been **removed**. Compose the module's exported `accountsSchema` fragment into `createApp({ schema })` (and into the testcontainer harness, now re-exported cleanly as `@sixthsummit/ship-api/testing`): `createApp({ schema: { ...accountsSchema, ...yourTables } })`. `refresh_tokens` lives in the accounts module alongside `accounts` (it FKs it), with its FK intact.

  **Module location**: modules are delivered as reference source copied into the consumer app, and now live under **`src/modules/<name>`** — both `ship-api add <module>` and the `ship-api g module|resource|service|schema|job` scaffolders target it, and the `create` template composes them from there.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`c54f7d1`](https://github.com/SixthSummit/ship-api/commit/c54f7d146cfe0b316603b12e463f5cda744fbb88) Thanks [@selosindis](https://github.com/selosindis)! - A2-1 — tenancy as an opt-in primitive. Tenancy is never a core default; the framework ships the _shape_ and forces nothing.

  - **`tenantScoped(tenants)`** — new opt-in column mixin (the sibling of `baseFields`), exported from `@sixthsummit/ship-api` and `@sixthsummit/ship-api/app/db/tenantScoped`. Spread it into a domain table to add a non-null `tenant_id` uuid FK to your `tenants` root table (`onDelete: "restrict"`). It's a factory (you pass your own `tenants` table) so core references no concrete table.
  - **`resolveTenant()`** — new opt-in middleware that publishes the active tenant to `RequestContext.tenantId` (default: from the authenticated account; or a custom resolver). Convention: read the active tenant from `RequestContext.tenantId`, never `account.tenantId` directly — this keeps a future one-tenant-per-user → membership move a one-middleware change.
  - **`requireAuth` now publishes `RequestContext.userId`** from the resolved account — honoring its documented contract and fixing `createdBy` / `updatedBy` audit-stamping, which was silently always-null because the field was never set. Affects all apps, not just multi-tenant.
  - **accounts module** ships an opt-in `tenants` table + `tenantsSchema` fragment (separate from `accountsSchema`, so single-tenant apps never get a tenants table) and a commented `accounts.tenantId` example for the one-tenant-per-account model.
  - **`outbox_events.tenant_id`** reconciled from `text` to `uuid` (still nullable; the outbox carries system/global events, no FK). The generated migration is an `ALTER COLUMN ... TYPE uuid USING tenant_id::uuid` cast — **before regenerating, ensure every existing `outbox_events.tenant_id` is `NULL` or a valid UUID**; rows with non-UUID text fail the cast and must be back-filled or deleted first.

  Tenant _enforcement_ (RLS / `withTenant` auto-scoping) remains deferred to a later release; A2-1 ships the column shape + resolution convention + docs (`docs/v4/concepts/tenancy.md`).

### Patch Changes

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`3df355c`](https://github.com/SixthSummit/ship-api/commit/3df355c05b0991c510251cb90899290d85e7bce0) Thanks [@selosindis](https://github.com/selosindis)! - A2-8 — agent output-parity instrumentation. The `ship-api g module` / `g resource` scaffold breadcrumb now also records `tool` (the agent/editor that drove the generator) in `module.json`'s `scaffold` block, so the time-to-module delivery metric can split by tool (Claude Code vs Cursor). Claude Code auto-detects via `CLAUDECODE`; Cursor has no reliable env marker, so set `SHIP_API_SCAFFOLD_TOOL=cursor` (the override also serves CI). Metadata only — no runtime effect.

  Companion docs (not shipped in the package): the G4 **agent-parity rubric** (`docs/AGENT_PARITY_RUBRIC.md`) formalizing the manual "does a real agent session produce a working module" eval into a scored, per-tool scorecard, and a new **M6 (agent output-parity)** metric + retro tool-dimension in `docs/DELIVERY_METRICS.md`.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`a8f9d08`](https://github.com/SixthSummit/ship-api/commit/a8f9d086229709e52266cfba6eeb32e6b4aaae45) Thanks [@selosindis](https://github.com/selosindis)! - AI-A3 — `libraries/ai` is versioned independently of the framework core. Libraries are copied-in reference source, so this is a meaningful `library.json#version` recorded into the consumer + a changelog convention (not a separate npm package, which would invert the copied-in model).

  - `ship-api add -l <lib>` now stamps `src/lib/<name>/.ship-lib.json` (`{ name, version, source, at, frameworkVersion }`) from the library's `library.json`, so the vendored library version is durable in the consumer's git history — staleness is detectable and `ship-api update` has an anchor. Mirrors the `g`-scaffold provenance breadcrumb.
  - `libraries/ai` bumped `0.1.0` → `0.2.0` for the Part-II AI-R1/R2/R3 changes, independent of the framework's `4.0.0-alpha.2`; added `libraries/ai/CHANGELOG.md` + a README Versioning section.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`a7d5d04`](https://github.com/SixthSummit/ship-api/commit/a7d5d04e2b37d06baea656c18b2e0c73b9906c1c) Thanks [@selosindis](https://github.com/selosindis)! - Security-audit dependency hardening — clears both criticals and every fixable moderate from `npm audit` (27 findings → 4, all remaining in the docs-site astro chain).

  - **firebase-admin `^12.3.0` → `^13.10.0`** (core dependency + default template, moved in lockstep so consumer apps dedupe to one copy and the default-app registration stays shared). The `FirebaseAuthProvider` adapter surface (`admin.auth()`, `verifyIdToken`, `DecodedIdToken`, `admin.app.App`) is unchanged in v13; its floor is Node 18, below the framework's Node 22 engine.
  - **vitest `^3.2.4` → `^4.1.8`** (+ `@vitest/coverage-v8`) — fixes GHSA-5xrq-8626-4rwp (critical, Vitest UI arbitrary file read/execute). One v4 migration touch: `vi.fn()` now respects the implementation's constructibility, so the `Resend` mocks in `libraries/email` use `function` expressions instead of arrows. Template's vitest moves to `^4.1.8` too.
  - **@testcontainers/postgresql + localstack `^11.14.0` → `^12.0.1`** — clears the vulnerable dockerode→uuid chain in the integration-test stack.
  - **Overrides** for transitives with no upstream fix: `uuid ^11.1.1` (Google API client chains under firebase-admin/@google-cloud/storage pin uuid 8/9 — GHSA-w5hq-g745-h8pq), `esbuild ^0.25.0` under drizzle-kit's deprecated `@esbuild-kit` loader (GHSA-67mh-4wv8-2f99), and `yaml ^2.8.3` under `yaml-language-server` (GHSA-48c2-rrv3-qjmp). The template ships the uuid + esbuild overrides so scaffolded apps audit clean as well.

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`8c182e5`](https://github.com/SixthSummit/ship-api/commit/8c182e5cdafbac99f3a670259dbbe9ccbfadf11f) Thanks [@selosindis](https://github.com/selosindis)! - Module + library tests now run in `npm test` / CI via the root vitest config, instead of the core workspace only. Wiring them in surfaced — and fixed — pre-existing breakage that had been silently un-run: `libraries/chunking` (the repo never installed its manifest-declared `tiktoken`) and `libraries/email`.

  `EmailService` no longer imports the host app's `environment` module. Config (`apiKey`, `defaultFrom`) is passed via the constructor — which it already accepted — and the implicit env fallback is removed, so `new EmailService()` with no args now throws. Pass values from your validated env instead: `new EmailService(env.RESEND_API_KEY, env.RESEND_DEFAULT_FROM)`. This decouples the library from the consumer app's file structure (it was the only library reaching up into the host's `../../environment.js`).

- [#100](https://github.com/SixthSummit/ship-api/pull/100) [`acbfb2e`](https://github.com/SixthSummit/ship-api/commit/acbfb2e07491a5801059373691572df1909e9d82) Thanks [@selosindis](https://github.com/selosindis)! - `ship-api g module` / `g resource` now stamp scaffold provenance into the generated `module.json` — a `scaffold` block recording the `generator`, module `name`, ISO `at` timestamp, and `frameworkVersion`. This is the un-backfillable start-point breadcrumb for the "time-to-module" delivery metric (see `docs/DELIVERY_METRICS.md`): it rides into git as part of the module, so it survives rebases/squashes and needs no commit-message discipline. No effect on a module's runtime behavior; the field is metadata only.

## 4.0.0-alpha.1

### Patch Changes

- [#98](https://github.com/SixthSummit/ship-api/pull/98) [`302b06d`](https://github.com/SixthSummit/ship-api/commit/302b06d421570b75de3028e82aec473ca66ee487) Thanks [@selosindis](https://github.com/selosindis)! - Initial v4 alpha — a TypeScript backend framework on Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry, designed to be edited by AI coding agents.
  - **Core**: `createApp<TSchema>` Hono factory with route-registry capture, `DrizzleEntityService` (generic CRUD/list/search + lifecycle hooks), the neutral `QueryOptions` operator DSL, and the `baseFields` audit-column mixin.
  - **Auth & access**: pluggable `AuthProvider` (with a `FirebaseAuthProvider` adapter), an ES256 JWT signer with refresh-token rotation, and `requireAuth` / `requirePermission` / `apiKey` / `rateLimit` / `idempotency` / `csrf` middleware.
  - **HTTP**: the AppError taxonomy with uniform error shaping, the `validate()` zValidator wrapper, SSE + `streamLLM` streaming, `@hono/node-ws` WebSockets with subprotocol auth, upload + webhook parsers, and `/livez` + `/readyz` health checks.
  - **Infrastructure**: BullMQ `defineJob` / `defineCron`, a transactional `outbox`, a Redis cache with tag invalidation, S3 / Disk / GCS storage adapters, and pino + OpenTelemetry observability with a Prometheus exporter.
  - **Consumer surface**: a typed `hc()` client subpath (no codegen), the `ship-api create` / `dev` / `g` CLI, the `migrate-orm` TypeORM→Drizzle codemod, and three reference modules (`accounts`, `oauth`, `outbox`).
  - **Agent tooling**: a bundled Claude Code plugin and MCP server (`list_routes` / `describe_route` / `find_route_collisions` / `execute_route`).

This file tracks the framework package (`@sixthsummit/ship-api`). From its first published release (`4.0.0-alpha.1`) onward, entries are auto-managed by [Changesets](https://github.com/changesets/changesets) — contributors describe user-visible changes in `.changeset/*.md` files, and `changesets/action@v1` aggregates them into a "Version Packages" PR that bumps versions and prepends entries on merge.

The Claude plugin (`@sixthsummit/ship-api-claude-plugin`) and MCP server (`@sixthsummit/ship-api-mcp-server`) keep their own CHANGELOGs at `packages/claude-plugin/CHANGELOG.md` and `packages/mcp-server/CHANGELOG.md`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

_Pre-publication note: the v4 framework iterated through internal pre-publication tags (`4.0.0-alpha.0` through `4.0.0-alpha.2`) that were never published to a registry. The version line was reset so that `4.0.0-alpha.1` is the first release actually published to GitHub Packages — Changesets prepends its entry above this note on the first release. For the pre-publication cut-over history, see `git log` on the `v4` branch._

## [3.0.0](https://github.com/SixthSummit/ship-api/compare/v2.3.0...v3.0.0) (2026-01-21)

### ⚠ BREAKING CHANGES

- restructure to monorepo with modular CLI architecture

### Features

- restructure to monorepo with modular CLI architecture ([407f6e6](https://github.com/SixthSummit/ship-api/commit/407f6e6))
- add installable libraries support via CLI ([cdebcdd](https://github.com/SixthSummit/ship-api/commit/cdebcdd20f9fd58716aa05fc8f37a8de532e3cab))
- add support for auto-installing npm dependencies defined in a library or module ([149f690](https://github.com/SixthSummit/ship-api/commit/149f690be525179ea0a5815351664d752cdae8bb))
- **cli:** add template audit script and documentation ([d6ae830](https://github.com/SixthSummit/ship-api/commit/d6ae830))

### Bug Fixes

- update release-please config and tests for monorepo structure ([4e25a66](https://github.com/SixthSummit/ship-api/commit/4e25a66282c33f77cad38e8b4e8751ac3a073c67))
- lock files not included in release commits ([56578b2](https://github.com/SixthSummit/ship-api/commit/56578b2))

### Code Refactoring

- **cli:** simplify template package.json for easier maintenance ([9af7ca6](https://github.com/SixthSummit/ship-api/commit/9af7ca67cd36cf72f868b63414bdfe69c702c1fd))
- **services:** simplify EntityService relationship handling ([0bdbcde](https://github.com/SixthSummit/ship-api/commit/0bdbcde))
