# ShipAngular redesign audit

> Status: redesign accepted; implementation authorized on the dedicated branch on 2026-09-03. Audited ShipAngular baseline: `dev` at `a571978`. Audited ShipAPI direction: `rearchitecture/agent-native-framework` at `7f3e5ca`. Audit branch: `audit/operation-client-redesign`.

## Executive verdict

ShipAngular should be reworked around an operation client, but it should not be rewritten from scratch.

The repository has a useful Angular core: standalone components, signals, functional dependency injection, browser/SSR guards, auth-adapter conformance tests, upload progress via XHR, packed-package machinery, Changesets, and a small published bundle. The provider factory behind `provideShipApiClient()` is also the right _kind_ of Angular seam even though its Hono-shaped contract is not.

The weak part is the ShipAPI boundary. The current design exposes Hono `hc()` through arbitrary async thunks, loses error and response metadata, implements the same request concerns twice, and treats optional cross-repository smoke tests and documentation as contract enforcement. Several copied modules and templates also sit outside the normal compiler, lint, test, and dependency-analysis graph. This creates more confidence than evidence.

The recommended direction is:

1. ShipAPI generates a deterministic, browser-safe contract and supplies a structural HTTP operation client.
2. ShipAngular injects that structural client, supplies request-scoped Angular context, and owns signals, presentation errors, auth integration, and browser transports.
3. Declared application failures remain typed values; transport and protocol accidents remain exceptions.
4. Uploads, downloads, streams, and sockets are explicit contract capabilities sharing one operation-aware request-policy pipeline.
5. Existing Hono v4 consumers use an isolated compatibility adapter for one measured migration window.
6. A packed, joint conformance fixture replaces source links and optional smoke tests.

This is a boundary redesign, not a collapse of ShipAngular and ShipAPI. ShipAngular remains frontend-only, and its third-party REST facilities remain independent.

## Scope and evidence

The audit read the four ShipAPI rearchitecture records named in the handoff and the ShipAngular contract-critical sources, tests, schematics, templates, modules, CI, custom ESLint rules, and agent instructions. The exact Hono/v4 inventory is in [CURRENT_COUPLING_MAP.md](CURRENT_COUPLING_MAP.md), and the cross-repository test design is in [JOINT_CONFORMANCE_PLAN.md](JOINT_CONFORMANCE_PLAN.md).

Local verification of the audited baseline produced the following results:

| Check                    | Result                                 | What it proves or fails to prove                                                                                                              |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run type-check`     | Pass                                   | The configured core/docs TypeScript projects compile. Copied modules are not workspace projects.                                              |
| `npm run lint`           | Pass                                   | Configured files satisfy the current rules. Templates are ignored, and several custom rules do not enforce the documented claim.              |
| `npm run test`           | Pass: 244 tests, 6 skipped             | Unit-tested core behavior passes. All six ShipAPI smoke tests skip when a sibling checkout/package is absent.                                 |
| `npm run build`          | Pass                                   | The core package and docs build. The post-build copier can still suppress module-copy failures.                                               |
| `npm run test:coverage`  | Pass, no threshold                     | 85.79% statements, 78.76% branches, 82.81% functions, 87.47% lines. Coverage is informative, not a gate.                                      |
| `npm run measure-bundle` | Pass                                   | Current aggregate gzip result is 51.61 KiB against the repository baseline. This is a relative regression check, not a per-entrypoint budget. |
| `npm run knip`           | Exit 0 with seven hints                | The analyzed graph is clean enough to pass, but `modules/**` and `libraries/**` are explicitly excluded.                                      |
| `npm run ci`             | Fails at format check in this checkout | Prettier scans ignored local `.claude/settings.local.json`. The standard command is sensitive to developer-local ignored files.               |
| package dry run          | Pass: 195 files, 224,664 bytes packed  | Package contents are inspectable, but include copied raw module TypeScript and omit the documented custom ESLint plugin.                      |

The committed `package-lock.json` also contains extraneous `../ship-api` and `../ship-api/../packages/angular` package records even though `npm ls @sixthsummit/ship-api` reports no declared dependency. This does not create a runtime dependency by itself, but it makes dependency and browser-safety review unreliable.

## What is worth keeping

### Angular-native public behavior

- Signals are the appropriate presentation and resource primitive.
- Standalone components, `inject()`, functional guards/interceptors, and OnPush are sound conventions.
- `OnlineService` handles platform checks, `DestroyRef`, and cancellation more carefully than most of the transport code.
- `provideShipApiClient()` demonstrates the correct direction: use an Angular provider factory and consult the SSR `REQUEST` at construction. Generalize this to a typed client token and a sanitized request context.

### Frontend-owned identity and browser transports

- `AuthAdapter` is a valuable provider boundary, and its reusable conformance suite is a pattern to extend.
- `ApiError` is useful as a presentation convenience after it stops being the only place where response information survives.
- XHR remains justified for upload progress. The redesign should adapt XHR to the common credential/header policy rather than replace it with `fetch` and lose progress.
- Stream, socket, signed upload, resource, and form concepts belong on the frontend. Their current APIs do not need to be preserved where they encode the wrong contract.

### Release discipline

- Changesets, bundle measurement, package dry runs, SSR/browser tests, and public-export tests are the right categories.
- The missing piece is making them cover what ships and making the packed cross-repository contract mandatory.

## Findings

Severity means: **critical** can cause data/security/cross-user failures or invalidates the central contract; **high** is a likely correctness or release-integrity defect; **medium** is structural debt that will obstruct the redesign; **low** is misleading or inefficient but bounded.

### F-01 — The permanent Hono route-tree contract is obsolete

- **Severity:** critical
- **Evidence:** `docs/architecture/CONTRACT.md`, `../packages/angular/src/api/shipapi/provideShipApiClient.ts`, `../packages/angular/src/api/resource/createResource.ts`, the API-client schematic, `connect-shipapi`, and `migrate-rest-to-hono` all make `hc<typeof app>` or an `hc()` response thunk the primary ShipAPI path.
- **Impact:** frontend types depend on server route nesting and Hono response narrowing; an application must expose/import server-derived types; serialization and capability metadata have no stable operation-level home.
- **Disposition:** accept [decisions/0002-operation-client-contract.md](decisions/0002-operation-client-contract.md). Move Hono behavior to a temporary adapter and make stable operation IDs the frontend contract.

### F-02 — `ApiClient` destroys failure information

- **Severity:** critical
- **Evidence:** `../packages/angular/src/api/client/ApiClient.ts` catches every failure from `HttpClient` and throws a new message-only `Error`.
- **Impact:** status, code, body, details, response headers, request ID, and cause are lost. UIs cannot distinguish declared denial, validation, rate limiting, network failure, or a proxy error.
- **Disposition:** generic REST should preserve a structured HTTP result/error. Operation calls should return declared failures as `OperationResult` values and reserve exceptions for cancellation, transport, protocol, and programmer failures.

### F-03 — `createResource()` probes and executes arbitrary input

- **Severity:** high
- **Evidence:** `../packages/angular/src/api/resource/createResource.ts` calls `source()` during construction to discover whether its return is a URL or promise. The promise is already in flight before Angular's loader owns it. The thunk shape cannot accept the loader's `AbortSignal`; URL calls use `firstValueFrom` without binding loader cancellation to the subscription.
- **Impact:** construction has hidden side effects, signal reads in thunks are not resource dependencies, stale calls can continue, and cancellation is best-effort. An arbitrary function is executed to infer a type that TypeScript already knew at compile time.
- **Disposition:** split explicit APIs: `createHttpResource`, `createAsyncResource`, and `createOperationResource`. Deprecate the probing overload rather than carrying it into the new kernel.

### F-04 — Error parsing confuses declared failures with protocol failures

- **Severity:** high
- **Evidence:** `ApiError.fromResponse()` synthesizes an application-looking code for malformed JSON, HTML, or a non-envelope response. It does not retain a complete response-metadata object or unknown additive envelope fields.
- **Impact:** a CDN/proxy failure can masquerade as a declared backend error, while request IDs and diagnostic metadata disappear.
- **Disposition:** preserve valid failure envelopes losslessly; model non-JSON/wrong-shape bodies as `ProtocolError`; model inability to reach the server as `TransportError`; keep abort distinct. `ApiError<TCode>` becomes an optional presentation wrapper over a failed operation result.

### F-05 — Request policy is duplicated and unsafe for mutations

- **Severity:** critical
- **Evidence:** auth, CSRF, request ID, idempotency, and rate limiting exist both as Angular interceptors and `withX(fetch)` wrappers. Both rate-limit implementations can retry any request after a 429 without consulting method, operation metadata, or an idempotency contract. The documented `connect-shipapi` example enables automatic retry globally.
- **Impact:** a mutation may run twice; policy behavior diverges by transport; backoff is not consistently abortable; a consumed fetch body may not be replayable.
- **Disposition:** one operation-aware pipeline prepares every ShipAPI attempt. Retry safe operations only by default; retry unsafe operations only when the contract permits it and a stable idempotency key exists. Re-read credentials for every attempt, obey `Retry-After`, and make both network and delay abortable.

### F-06 — CSRF and credential policy are not scoped to the API origin

- **Severity:** high
- **Evidence:** the auth interceptor has an origin allowlist, but the CSRF interceptor/wrapper adds the cookie-derived token to every mutating request. Cookie-mode `withCredentials` behavior also depends on whether the bearer-token branch ran.
- **Impact:** a CSRF value can be disclosed to a third-party origin, and cookie-session calls may silently omit credentials.
- **Disposition:** bind cookie mode, credential inclusion, CSRF supply, and allowed origins into one explicit auth capability. Refuse to attach sensitive headers outside the configured ShipAPI origins.

### F-07 — Upload and signed-upload state bypasses shared policy and has races

- **Severity:** high
- **Evidence:** `createUpload` asks callers to construct auth headers manually, treats invalid JSON success text as generic `TResponse`, and `reset()` does not abort an active XHR. `createSignedUpload.signRequest` receives no `AbortSignal`, and a late signing promise can take control after another start/abort cycle.
- **Impact:** stale callbacks can overwrite current UI state, credentials drift from normal calls, cancellation is incomplete, and response typing is unsound.
- **Disposition:** keep XHR behind an `UploadClient` capability that consumes the common prepared-request context. Add generation IDs, destroy cleanup, abortable signing, contract-declared field/media/size constraints, and explicit success/error decoders.

### F-08 — Stream and socket protocols are handwritten and incomplete

- **Severity:** high
- **Evidence:** the Hono stream thunk cannot receive the resource signal; default stream decoding silently drops malformed JSON; frame buffering and reconnect policy are not contract-derived; the SSE parser resets `lastEventId` despite documenting it as sticky. `createSocket` hard-codes `ship-api.v1`, auto-reconnects by default, silently drops sends/invalid frames, retains unbounded messages, and has no `DestroyRef` cleanup.
- **Impact:** aborts can hang, protocol failures disappear, browser memory grows, and the two repositories can drift on message/event shapes.
- **Disposition:** use separate typed stream/socket capabilities with contract decoders, bounded buffering, explicit completion/abort/protocol states, refreshed credentials on reconnect, and inert SSR construction. Do not put bearer credentials in query strings.

### F-09 — Session auth collapses materially different states

- **Severity:** high
- **Evidence:** `SessionAuthAdapter` hard-codes v4 auth paths, performs raw fetches, starts a probe in its constructor, casts provider payloads in `defaultMapUser`, and marks the client signed out even when the server-side sign-out failed. The probe treats network/protocol/server failure as unauthenticated.
- **Impact:** the UI can claim a user is signed out while an HttpOnly session remains valid, and transient outages look like identity decisions. SSR cookie forwarding is left to ad hoc fetch construction.
- **Disposition:** keep the frontend identity boundary but inject structural auth operations and optional auth capabilities. Represent indeterminate/recoverable failure explicitly; only commit signed-out state when the session contract warrants it.

### F-10 — Schema forms are not safely typed or contract-derived

- **Severity:** high
- **Evidence:** `createSchemaForm` defaults its value type to `Record<string, unknown>`, constructs untyped controls, and double-casts them to `SchemaFormGroup<V>`. It probes schemas with guessed values to infer control types and maps omitted optionals to sentinels such as `''`, `0`, and `false`. Documentation proposes importing Drizzle/Zod schemas from the server package.
- **Impact:** compile-time form shape can diverge from runtime controls; refinements/transforms may execute during discovery; omitted, null, and empty values lose distinct meaning; a browser may pull server/runtime code.
- **Disposition:** consume only a client-safe form-schema projection. Recommended default: a supported JSON Schema subset with explicit codecs and UI annotations, plus an optional browser-safe Zod/Standard Schema adapter in a secondary entrypoint. Server validation remains authoritative.

### F-11 — The cross-repository test is optional and source-linked

- **Severity:** critical
- **Evidence:** `createResource.shipapi-smoke.spec.ts` dynamically imports sibling ShipAPI internals through `Function` and switches the entire suite to `describe.skip` when unavailable. Six tests skipped in this audit. `../packages/angular/CLAUDE.md` explicitly describes local linking instead of a mandatory packed boundary.
- **Impact:** both repositories can pass independently while their released artifacts are incompatible or browser-unsafe.
- **Disposition:** replace it with the packed fixture and ownership model in [JOINT_CONFORMANCE_PLAN.md](JOINT_CONFORMANCE_PLAN.md). No workspace links and no optional contract suite in required CI.

### F-12 — Modules and templates are outside the quality graph

- **Severity:** high
- **Evidence:** root workspaces include `packages/*` and `apps/*`, not `modules/*`; `knip.json` explicitly ignores modules and libraries; the build script copies raw module sources into the package and suppresses copy failures. The starter ESLint config does not load ShipAngular rules, and the starter welcome component lacks OnPush. Shipped modules still contain legacy structural directives despite documentation saying migration is complete.
- **Impact:** code advertised and packaged as framework functionality can avoid type-check, lint, unit coverage, dependency analysis, and public API review. Copy failures can produce a successful but incomplete release.
- **Disposition:** stop treating copied source as an invisible package subsystem. Put maintained reusable features in real workspace packages/secondary entrypoints; move demonstrations to example apps; make any app-owned code generation explicit and test it from a clean packed install. Copy/build errors must fail.

### F-13 — The AI module crosses the frontend boundary

- **Severity:** high
- **Evidence:** `modules/ai/services/ai-client.service.ts` uses raw fetch, parses SSE by splitting individual chunks on newlines, and executes `ToolDefinition.run` handlers in the browser. Its manifest installs an Anthropic SDK that the service does not use and instructs consumers around an API key.
- **Impact:** split SSE frames are corrupted, server tools can be misrepresented as browser-safe actions, secrets can be mishandled, and dependency weight is unexplained.
- **Disposition:** remove direct model-provider behavior from the framework surface. Make the module a UI example over declared ShipAPI chat/stream/tool operations; all provider credentials and privileged tools remain in ShipAPI.

### F-14 — Custom lint claims exceed actual enforcement

- **Severity:** medium
- **Evidence:** `no-rxjs-in-public-api` only inspects declarations physically present in `public-api.ts`, while that file primarily re-exports symbols. The route rule recognizes only selected literal/variable shapes. Templates are ignored. The custom plugin is neither included in the packed core package nor configured by the starter.
- **Impact:** agents are told invariants are machine-enforced when violations can ship. This is especially dangerous for an “agent-native” framework because prompts become a substitute for proof.
- **Disposition:** express public API rules through API-extractor/type fixtures and compiler tests where possible; retain narrow Angular ESLint rules for AST/template facts; test every rule against negative fixtures; package/configure the plugin if it is part of the consumer product.

### F-15 — Documentation describes APIs that do not exist

- **Severity:** medium
- **Evidence:** `docs/api/LIBRARY_EXPORTS.md` documents thunk ETag options, thunk signal retracking, stream methods/properties, error enum members, and retry field names that do not match source. Agent skills repeat unsafe retry and Hono assumptions.
- **Impact:** users and agents generate incorrect code, then compensate with local hacks.
- **Disposition:** contract-test examples and generated API references. Mark Hono guidance as legacy after the ADR is accepted; never use prompts as the only integration mechanism.

### F-16 — The workspace and CI graph has blind spots

- **Severity:** medium
- **Evidence:** Turbo already exists but schedules phantom workspace tasks and makes the root test path build docs. Coverage has no thresholds; size-limit is not in the normal CI chain; security audit is allowed to fail; packed scaffold E2E does not run for pull requests or the active `dev` trunk; `scripts/ci-check.sh` invokes a root script that does not exist.
- **Impact:** local and CI commands prove different things, waste time, and allow release-critical surfaces to remain unverified.
- **Disposition:** define a single release-proof graph with explicit workspace tasks, outputs, and mandatory packed consumers. Delete stale scripts rather than maintaining parallel CI stories.

## Target architecture

### Ownership boundary

```text
ShipAPI build
  operation graph
    -> browser-safe contract artifact (types + metadata + codecs/hash)
    -> default structural HTTP client
    -> fixture server and wire fixtures (development packages only)

ShipAngular
  Angular DI + sanitized browser/SSR call context
    -> structural OperationClient<TContract>
    -> operation-aware request-policy pipeline
    -> createOperationResource / createOperationMutation
    -> upload / download / stream / socket capability adapters
    -> auth identity + presentation error adaptation

Independent path
  generic HttpClient/REST helpers -> third-party APIs
```

ShipAngular must not import a composed Hono app, server handler, database schema, auth-provider runtime, or ShipAPI runtime package. Type-only imports from an application's generated browser package are acceptable; the default client package must also be browser-safe and independently packable.

### Structural operation seam

The minimum core shape is deliberately boring:

```ts
export interface OperationClient<TContract> {
  call<TId extends OperationId<TContract>>(
    operation: TId,
    input: InputOf<TContract, TId>,
    options?: OperationCallOptions
  ): Promise<OperationResultOf<TContract, TId>>;
}

export interface OperationCallOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  timeoutMs?: number;
}
```

The contract supplies stable IDs, separated path/query/header/body inputs, status-indexed successes, declared error codes, serialization codecs, and transport/capability metadata. Named generated methods may delegate to `call`; they may not replace the structural seam.

`OperationResult` retains status and `ResponseMetadata` on both branches. A valid declared error is `{ ok: false }`, not an exception. `TransportError`, `ProtocolError`, cancellation, and programmer errors are exceptional. Unknown additive error fields and `details` remain accessible even when ShipAngular cannot interpret them.

### One request-policy pipeline

The pipeline is operation-aware and transport-neutral at the policy layer:

1. resolve current credentials for this attempt;
2. verify allowed origin and choose cookie/bearer mode;
3. attach CSRF only for the declared cookie-session policy;
4. create or forward request ID and approved trace/locale headers;
5. attach a stable idempotency key when requested/permitted;
6. compose caller, timeout, and SSR-abandon signals;
7. execute through fetch, HttpClient, XHR, stream, or socket handshake adapter;
8. parse response metadata and decide whether a retry is contract-safe.

An unsafe operation is never retried solely because it failed. Auth/authz denial is never retried by backoff. A credential capability may perform one explicitly modeled refresh and replay when allowed. XHR and WebSocket adapters consume prepared credentials/headers but own their transport-specific execution.

### Browser and SSR DI

Replace the untyped global token with a token factory, for example `createShipClientToken<TContract>()`, so applications do not cast `SHIP_API_CLIENT`. `provideShipClient()` creates one client/context per Angular request injector.

The SSR context forwards only configured fields: approved cookie(s) in cookie mode, request ID, locale, approved trace headers, API origin, and request-abandon signal. It never copies all incoming headers and never retains a request or credential in a platform singleton. Browser credential providers are read per attempt so a refreshed token is not captured at bootstrap.

### Reactive API

`createOperationResource(client, operationId, inputFactory, options)` is explicit. Angular tracks signals read by `inputFactory`; its loader passes the resource `AbortSignal` to `call`; a generation guard prevents stale completion from winning. The resource exposes typed data, discriminated application failure, exceptional failure, response metadata, reload, and a well-defined previous-value policy.

Mutations use a separate `createOperationMutation`. Optimistic behavior requires an explicit apply/rollback/reconcile policy and never enables generic automatic retries. Generic third-party helpers remain `createHttpResource`/`ApiClient`; `createAsyncResource` may exist for non-ShipAPI promises but has no mode probing.

### Non-JSON capabilities

- `OperationUploadClient` validates contract-declared browser constraints, prepares shared credentials, and uses XHR for progress. Signed upload is an explicit sign operation plus provider upload capability.
- `OperationDownloadClient` chooses Blob, ArrayBuffer, or ReadableStream and parses the standard JSON failure envelope before treating the response as binary.
- `OperationStreamClient` uses contract event decoders and exposes completion, abort, transport failure, protocol failure, event ID, and an operation-approved reconnect policy.
- `OperationSocketClient` derives URL, protocol, message codecs, close-code policy, and reconnect permission from the contract; it re-resolves auth on reconnect and stays inert during SSR.

### Package surface

Start with Angular secondary entrypoints inside one npm package, not a fleet of independently versioned packages:

| Entrypoint                             | Responsibility                                                           |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `@sixthsummit/ship-angular/operations` | tokens, provider, operation resources/mutations, result/error adaptation |
| `@sixthsummit/ship-angular/http`       | independent third-party REST helpers and HttpClient interceptors         |
| `@sixthsummit/ship-angular/auth`       | identity state, adapter/capability interfaces, guards                    |
| `@sixthsummit/ship-angular/upload`     | upload and signed-upload UI state/adapters                               |
| `@sixthsummit/ship-angular/stream`     | SSE/chunked stream UI state/adapters                                     |
| `@sixthsummit/ship-angular/socket`     | browser WebSocket UI state/adapters                                      |
| `@sixthsummit/ship-angular/forms`      | schema-form core and JSON Schema projection                              |
| `@sixthsummit/ship-angular/forms/zod`  | optional browser-safe adapter; Zod peer isolated from core               |
| `@sixthsummit/ship-angular/testing`    | framework-independent fakes and conformance runners                      |
| package root                           | compatibility re-exports during migration, then a curated small surface  |

Maintained feature code becomes a compiled workspace package or an example app. The CLI should become a thin wrapper around schematics, migrations, and diagnostics. Source-copy modules must explicitly state that generated code is app-owned and provide an upgrade migration; they should not masquerade as a maintained linked library.

## Compatibility plan

Introduce `HonoV4ClientAdapter` under a clearly named compatibility entrypoint. The consuming application supplies a generated mapping from stable operation IDs to legacy `hc()` calls; the adapter normalizes `Response` into the new result/error shape and passes `AbortSignal` where the legacy call permits it.

The adapter is intentionally limited:

- route-tree types remain inside the application/adapter mapping;
- JSON unary calls are the baseline;
- serialization and capability metadata may require explicit mapping;
- stream cancellation remains limited if a response is created before a signal is available;
- no core runtime dependency on Hono is introduced;
- every limitation produces a diagnostic rather than silent fallback.

The legacy REST adapter isolates copied URL clients behind the same operation boundary.

## Toolchain decision

### pnpm: adopt, in an isolated migration

pnpm is beneficial here because strict dependency resolution will expose undeclared dependencies, `workspace:` ranges make internal intent explicit, one lockfile can cover the joint fixture consumer, and ShipAPI is moving the same way. The migration must be its own change set after architecture tests exist: delete the contaminated npm lock through a deliberate reviewed change, generate `pnpm-lock.yaml`, update Changesets/release/cache commands, and prove Angular CLI, ng-packagr, docs, package packing, and a clean consumer install.

### Biome: use selectively, retain Angular-aware linting

Adopt Biome first for formatting, import organization, and supported TypeScript/JSON correctness rules. Do not remove Angular ESLint or template/compiler checks merely to claim one tool. Angular dependency injection, component metadata, templates, route declarations, and public type surfaces need Angular/compiler-aware evidence. Replace custom rules only after negative fixtures demonstrate equal or better coverage.

### Turbo: already present; repair before expanding

Do not “add Turborepo”; it already drives the root scripts. Remove phantom tasks, give each workspace an explicit script contract, correct inputs/outputs, and stop normal core tests from building unrelated docs. Keep Turbo if timing data shows useful caching once secondary entrypoints and fixture apps exist. If the graph remains only two or three cheap packages, pnpm recursive scripts are simpler and acceptable.

## Implementation sequence and healthy commits

Each numbered item is a review boundary, not a mega-PR. Behavior and tool migrations remain separate.

1. **Accept the contract ADR.** Add type-only joint fixtures and compile-negative cases; no runtime migration.
2. **Establish packed conformance.** ShipAPI emits contract/client tarballs and fixture manifest; ShipAngular installs them in a clean fixture app. Delete the optional sibling-import smoke test only when this is required CI.
3. **Add lossless result/error primitives.** Introduce `ResponseMetadata`, `OperationResult`, `TransportError`, and `ProtocolError` with wire fixtures. Keep existing `ApiError` behavior behind compatibility helpers.
4. **Add the typed provider and SSR context.** Test two concurrent request injectors, approved header forwarding, token freshness, and abandoned-render cancellation.
5. **Build one operation-aware HTTP pipeline.** Prove origin scoping, credentials, CSRF, request IDs, idempotency, abortable timeout/backoff, and safe retry. Do not migrate resources yet.
6. **Add explicit operation resource/mutation APIs.** Prove signal retracking, cancellation, stale suppression, metadata, expected failures, and optimistic rollback. Deprecate only the thunk-probing overload.
7. **Add the Hono v4 compatibility adapter.** Run the same resource cases against both clients and publish its limitations/deprecation window.
8. **Add the pre-Hono URL compatibility adapter.** Use the same target semantics without
   preserving message-only errors or moving URL construction into the kernel.
9. **Migrate session auth.** Use structural auth operations and explicit credential capabilities; prove server/client state remains honest on failure.
10. **Migrate upload and download capabilities.** Add XHR policy adaptation, races, bytes/metadata, and signed-upload conformance.
11. **Migrate stream and socket capabilities.** Use contract codecs/protocol metadata and deterministic reconnect/abort tests.
12. **Replace schema probing.** Add the chosen client-safe schema adapter and bundle/fidelity comparison; migrate form controls without changing omitted/null semantics.
13. **Make shipped code part of the graph.** Convert maintained modules to entrypoints/packages and examples to fixture apps; make copy/build errors fatal.
14. **Migrate npm to pnpm.** One mechanical commit with clean install/package/release proof.
15. **Introduce Biome.** One mechanical formatting commit, then small rule-equivalence commits; retain Angular ESLint until its responsibilities have replacements.
16. **Repair or remove Turbo.** Change task orchestration only after timing and cache evidence is captured.
17. **Remove deprecated compatibility/root exports.** Only after the site inventory is complete, every in-scope client has migration evidence, and the agreed rollback window has closed; publish a migration guide and changeset.

## Open decisions

Only these choices require cross-repository or product agreement before implementation:

| Decision                             | Recommended default                                                                                                          | Why it cannot be finalized here                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Contract package topology            | Per-application browser-only generated package plus a versioned shared runtime/client package                                | ShipAPI publishing and application deployment need to agree on registry and version ownership.                              |
| Runtime metadata representation      | Generated type declarations plus a small serializable manifest containing transport, codecs, policies, and graph hash        | Types alone disappear at runtime; a full schema bundle may be too large. Bundle and codec prototypes are needed.            |
| Client-safe form schema              | JSON Schema subset as default; optional browser Zod/Standard Schema adapter                                                  | Joint fixtures must measure fidelity, async/server-only refinements, tree shaking, and application ergonomics.              |
| Authentication capability vocabulary | Separate identity actions, bearer credential source, cookie session, and CSRF capabilities                                   | ShipAPI must declare which operations and refresh flows each application exposes.                                           |
| Compatibility removal point          | After every inventoried company site is upgraded and has completed its rollback window; old pinned releases remain available | Site owners must confirm production behavior and any private/unpublished integrations before compatibility code is removed. |
| Contract compatibility policy        | Deterministic graph hash plus semantic diff categories enforced in CI                                                        | ShipAPI must define which input/output/error/capability changes are breaking and how applications version artifacts.        |

Choices that do **not** remain open: ShipAngular stays frontend-only; stable operation IDs replace Hono route trees in the target seam; declared failures are values; third-party REST stays independent; no server/Drizzle runtime belongs in a browser contract; and required cross-repository tests use packed artifacts rather than source links.

## Exit criteria for the redesign

The redesign is solid enough for agents and humans only when:

- every shipped TypeScript/template surface participates in type-check, lint/compiler, tests, dependency analysis, and package-content review;
- a clean consumer can use only packed browser packages and cannot resolve server/Hono/Drizzle internals;
- operation inputs, successes, and declared errors are compile-time checked by stable ID;
- cancellation reaches fetch/XHR/stream work and stale completions cannot win;
- retry, credentials, CSRF, request IDs, and idempotency are one tested policy, not copied recipes;
- browser and concurrent SSR fixtures pass without global credential/request leakage;
- documentation examples compile, and generated contract drift fails CI;
- bundle budgets apply per secondary entrypoint; and
- prompts and skills explain the system but are never the only enforcement mechanism.
