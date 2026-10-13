# @sixthsummit/ship-angular

## 4.1.0

### Minor Changes

- [#18](https://github.com/SixthSummit/ship-angular/pull/18) [`4ace137`](https://github.com/SixthSummit/ship-angular/commit/4ace1371c1f07fb7b5a988096d8c04add384ef81) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - `provideShipOperationBoundary` now registers an Angular `PendingTasks` task for the whole duration of every operation call, including retries, and releases it when the call settles or aborts. `ApplicationRef.whenStable()`, SSR, hydration, and test harnesses wait for in-flight operations exactly as they wait for `HttpClient`. Pass `trackPendingTasks: false` in the boundary config to opt out.

- [#18](https://github.com/SixthSummit/ship-angular/pull/18) [`677a1d5`](https://github.com/SixthSummit/ship-angular/commit/677a1d5fe1d496ed235cd686bd074df81d084d33) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an opt-in per-call `keepalive` option to `OperationCallOptions`. The flag reaches the structural client on every attempt, including approved retries, through `createPolicyClient`, `createPolicyClientFromPolicy`, `createOperationMutation`, and the `/ship-api` executor, so a final progress or completion call issued from `pagehide` or a hidden tab no longer needs raw `fetch`. Nothing changes by default; browsers still cap keepalive bodies at 64 KiB.

## 4.0.1

### Patch Changes

- [#12](https://github.com/SixthSummit/ship-angular/pull/12) [`e75453f`](https://github.com/SixthSummit/ship-angular/commit/e75453ff7bf87b86013eddad0edaa07ed9cbece8) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Prevent delayed Firebase token results or errors from restoring signed-out users or replacing a newer session. Keep auth and token listener updates ordered, and discard bearer tokens returned after their session ends.

## 4.0.0

### Major Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`df78c5d`](https://github.com/SixthSummit/ship-angular/commit/df78c5d48040222dbf4a47a72e77fb3a4e4f0dc6) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Replace mandatory provider-specific AuthAdapter methods with discoverable auth capabilities and add an indeterminate identity state for transport and protocol failures.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fe0c187`](https://github.com/SixthSummit/ship-angular/commit/fe0c187894d96f05b1e360b6dd15daa706a9250b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Replace the URL-driven SessionAuthAdapter with an operation-backed session adapter in the auth entrypoint. Session initialization is explicit, failed logout preserves authenticated state, and network/protocol uncertainty becomes indeterminate rather than signed out.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fda9c1a`](https://github.com/SixthSummit/ship-angular/commit/fda9c1abeb54e3eac466ec5b062d38d92f47abd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Remove the uncompiled bundled module and library catalogs, keep feature generation app-owned under `src/app/modules`, make template rendering deterministic across every schematic, and make `--current-dir` refuse to delete or overwrite an existing project.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`ff572b6`](https://github.com/SixthSummit/ship-angular/commit/ff572b6b9c3448f8cfbd7b987e3dcb7a60ac1ed4) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an operation-session-auth schematic that generates contract-checked operation bindings and requires an application-owned identity decoder instead of casting unknown server data.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`bf712a8`](https://github.com/SixthSummit/ship-angular/commit/bf712a8a434b81757ab81ef59dc0efa9e080d707) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate structural operation-client boundaries, operation-backed upload and stream integrations, capability-based auth adapters, and a pnpm/Biome/Angular-ESLint application scaffold. Publish the framework ESLint plugin and share one request-scoped operation policy between generated clients and transports.

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Remove the legacy entity/model layer from the published surface:
  `AbstractEntityService`, the ORM-style models (`Account`, `Entity`,
  `Permission`, `Role` + their interfaces), and the legacy top-level interfaces
  (`AssetResponse`, `AuthError`, `PaginatorOptions`, `SearchOptions`). Data
  access on the 4.0 line is `createResource()` + the typed `hc()` client;
  schema-driven forms come from `createSchemaForm()`.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`a380ebd`](https://github.com/SixthSummit/ship-angular/commit/a380ebd846b510be342585bbf0b42a481ed90958) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Move `FirebaseAuthAdapter` from the package root to the optional `/firebase-auth` entrypoint and require explicit asynchronous adapter initialization so provider listeners do not start during construction and initialization failures remain honest, redacted auth state.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fc05681`](https://github.com/SixthSummit/ship-angular/commit/fc05681c810296f68826126096419cfc17a373dd) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dry-run-first CLI codemod for deterministic framework entrypoint imports. Firebase auth moves safely to its optional entrypoint while session auth and behavioral mappings remain explicit manual work.

### Minor Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`f2b4c8d`](https://github.com/SixthSummit/ship-angular/commit/f2b4c8d04ba74ca9a2f7bbd3141870ebc4d659bc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an explicit operation stream resource with generated request/event decoding, shared credentials and pre-stream error policy, bounded event history, sticky event IDs, approved reconnect behavior, current credentials on reconnect, cancellation, timeouts, and stale-reader protection.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`7c59c06`](https://github.com/SixthSummit/ship-angular/commit/7c59c063569bcb324fa91427b0fdfbdd27ea9d9d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the `/download` operation capability with generated request bindings, exact byte and stream preservation, declared JSON error decoding, response metadata and safe filename handling, shared authentication/request/retry policy, cancellation, timeout, stale-result protection, and origin enforcement.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`39cd955`](https://github.com/SixthSummit/ship-angular/commit/39cd9552cfa63cf07a13586f1bd7f58ef5f518ea) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add operation-resource and operation-mutation schematics that generate contract-inferred Angular
  wrappers without URLs, Hono coupling, untyped values, or message-based error handling.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8a733c9`](https://github.com/SixthSummit/ship-angular/commit/8a733c91a660db0adba3eb7fd5d48b840930e2dd) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the `/forms` operation integration with generated client-safe field bindings, typed Angular controls, explicit optional-field presence, stable validation issues, server issue mapping, and lossless date and bigint codecs without importing backend schema runtimes.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`3107319`](https://github.com/SixthSummit/ship-angular/commit/3107319dcee1d20785a32a12087446eebc466b96) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a non-mutating CLI migration audit that inventories legacy client, auth, error, serialization,
  transport, schema, and Angular DI patterns without guessing operation mappings or exposing source
  contents in its report.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`6836f3f`](https://github.com/SixthSummit/ship-angular/commit/6836f3fb088fd986038b3b01d66722eb1dc72cf1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add generated-binding-first schematics for downloads, sockets, signed uploads, and operation forms. Socket and signed-upload origins remain required caller policy rather than permissive generated defaults.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`d1b7653`](https://github.com/SixthSummit/ship-angular/commit/d1b765357faf5e2d3bc5179681b85635dc319b8a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an isolated Hono v4 compatibility adapter that maps legacy route-tree calls into typed operation results without adding Hono to the operation kernel.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`6a4ffc1`](https://github.com/SixthSummit/ship-angular/commit/6a4ffc16d13d239f6ae287073cb98ec98726d3ca) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a temporary `/legacy-rest` operation adapter for pinned applications that predate the Hono
  integration. App-owned mappings retain legacy URL construction while ShipAngular preserves typed
  results, response metadata, declared and unknown errors, cancellation, and shared request policy.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`e6539cc`](https://github.com/SixthSummit/ship-angular/commit/e6539cc3febb5d52f3ce870e481f7554e224b2d8) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Export a test-runner-independent operation-client conformance assertion and require packed,
  browser-safe contract boundary verification in CI.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`265b2a5`](https://github.com/SixthSummit/ship-angular/commit/265b2a54e110f159fac622b1ed96c4435ab5be3a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept ShipAPI's canonical nested operation type contract and add an import-free `/ship-api`
  adapter for its structural HTTP client and runtime manifest. The adapter preserves typed
  statuses, errors, request/response metadata, per-operation credential modes, unknown
  additive fields, 304 cache results, cancellation, and safe exceptional diagnostics.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`c5c4a0f`](https://github.com/SixthSummit/ship-angular/commit/c5c4a0fa4c169c5c87dca2c4fcf30ac18e6e72aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a typed signed-upload state machine that composes declared sign and completion operations with an origin-isolated provider transfer, cancellation, progress, advisory file validation, safe provider errors, and stale-callback protection.

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Ship the Sherpa QA-handoff surface and mirror it into the project template:
  the `/ship:sherpa-brief` slash command, the read-only `qa-brief` subagent,
  the app-developer skills (`add-page`, `add-protected-route`,
  `add-auth-adapter`), and a `sherpa-brief.yml` GitHub Action that posts a QA
  brief as a sticky PR comment and to Slack on merge. The headless CI path is
  hardened: read-only `--allowedTools`, heredoc-delimited step outputs, and
  diff/PR text treated as untrusted data.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`2ff4661`](https://github.com/SixthSummit/ship-angular/commit/2ff4661d3c4f906e8fd7fa5b3ec84f188657f2d6) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the browser-safe structural operation contract, typed Angular provider and sanitized SSR context, operation-aware credential/request/retry policy, status-indexed result types, lossless application error parsing, response metadata, presentation adaptation, and exceptional transport, protocol, timeout, and cancellation errors under the new `/operations` entrypoint.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`56a0248`](https://github.com/SixthSummit/ship-angular/commit/56a0248f20d8496957130ec115b751c89bd1093c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a typed `/upload` operation capability with generated multipart bindings, shared credentials and CSRF policy, advisory file constraints, progress signals, lossless expected errors, conservative retries, auth refresh, cancellation, timeouts, and stale-callback protection.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`dd8fb16`](https://github.com/SixthSummit/ship-angular/commit/dd8fb1683ee758451b2927985deb53a52ebdcdac) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dedicated `/stream` entrypoint with a cancellation-aware WHATWG SSE parser that handles arbitrary UTF-8 chunks, CR/LF boundaries, multiline data, sticky event IDs, and valid reconnect hints.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`eba8351`](https://github.com/SixthSummit/ship-angular/commit/eba8351236106866cb3903721bbc86b61ea87d94) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dedicated `/socket` operation capability with typed connection and message codecs, optional operation-backed tickets, exact origin and query credential guards, explicit send outcomes, bounded queues/history, declared close/reconnect policy, fresh tickets on reconnect, and inert SSR behavior.

### Patch Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`f38c218`](https://github.com/SixthSummit/ship-angular/commit/f38c2189953d6388310c313b6873e47093c44245) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Validate operation IDs, identifiers, package specifiers, names, and destination paths before rendering operation-oriented schematics so malformed or injected options cannot become generated TypeScript.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`7057467`](https://github.com/SixthSummit/ship-angular/commit/7057467ab4639b01bce258597a837e0f1caa279b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add company Conventional Commit, pull request, and reviewed-testing guidance to newly generated projects.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`dfe21bf`](https://github.com/SixthSummit/ship-angular/commit/dfe21bfeb2bf3fc68f2620dee0aff8e747be3794) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Preserve status, response bodies, request IDs, structured codes/details, and readable headers when the generic REST client fails, and correctly forward binary response and progress options to Angular HttpClient.

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`bf9e39b`](https://github.com/SixthSummit/ship-angular/commit/bf9e39bdde0674cfe40a3148c736afe797bb9bf5) Thanks [@selosindis](https://github.com/selosindis)! - Security dependency sweep — `npm audit` now reports 0 vulnerabilities. The
  framework builds against Angular 20.3.24 (clears the compiler XSS advisories
  GHSA-jrmj-c5cx-3cw6 / GHSA-g93w-mfhg-p222), and the project template now
  scaffolds vitest 4 (`^4.0.0`), clearing the vitest UI-server advisory
  (GHSA-5xrq-8626-4rwp) for generated apps. Peer ranges are unchanged —
  existing apps on `^20.0.0` resolve to patched Angular automatically.

  Template fixes that ride along: an `overrides` entry pins vitest past
  `@angular/build`'s `peerOptional vitest ^3.1.1` (Angular 20 hasn't widened it
  yet); `test-setup.ts` installs Web Streams polyfills before `msw/node` loads
  and imports `@angular/localize/init`; and the zoneless change-detection
  provider moved from `beforeAll` to `beforeEach` so it survives TestBed resets
  — a fresh scaffold now installs, type-checks, tests, and builds clean.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`a25bc1e`](https://github.com/SixthSummit/ship-angular/commit/a25bc1e550c5c3d5e6a4b56452394ca3fa732920) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Enable exact optional property checking across framework, schematics, documentation, and generated application TypeScript projects.

- [#7](https://github.com/SixthSummit/ship-angular/pull/7) [`537f51d`](https://github.com/SixthSummit/ship-angular/commit/537f51d4d9295bbae86d11ae23ca65a709b0fdf4) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the generated Playwright configuration so new projects pass TypeScript checking with exact optional property types enabled. CI still uses one worker; local runs use Playwright's default worker count.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8f38fbe`](https://github.com/SixthSummit/ship-angular/commit/8f38fbe6ee1fe8ef0d4b887e1eab4e088fc3416d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Refresh the framework's runtime dependency ranges and the workspace's Angular, Firebase, documentation and build dependency resolutions. The checked-in workspace now passes the high/critical dependency audit, which is enforced in CI and the local verification command. Consumers should refresh their own lockfiles and audit their installed dependencies; Angular and Firebase remain peer dependencies owned by the consuming application.

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Fix `ng add` / `ng generate`: the schematics compile to CommonJS inside a
  `"type": "module"` package, so the Angular CLI resolved every factory to
  `undefined`. A nested `schematics/package.json` (`{"type": "commonjs"}`) pins
  the subtree back to CJS, guarded by the build and a factory-loading
  regression spec. Also makes `defineEnv` compatible with zod 4 (structural
  `EnvSchemaLike` instead of the removed `ZodTypeDef`), matching the advertised
  `zod ^3.23 || ^4` peer range.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8f38fbe`](https://github.com/SixthSummit/ship-angular/commit/8f38fbe6ee1fe8ef0d4b887e1eab4e088fc3416d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Reject download redirects before credentials can cross origins. Preserve cancellation through streamed download completion, mutation caller signals and socket tickets. Keep automatic session refresh within the initiating action. Close protocol-invalid WebSockets with browser-valid application code 4002 and reject invalid close overrides.

- [#2](https://github.com/SixthSummit/ship-angular/pull/2) [`ebf04d7`](https://github.com/SixthSummit/ship-angular/commit/ebf04d7ec7e48f8f5f4d0a22b34529c1ec25453f) Thanks [@selosindis](https://github.com/selosindis)! - Fix an SSR deadlock in `authGuard` / `noAuthGuard`: both guards wait for the
  auth state to leave `'unknown'`, but no auth adapter runs on the server, so
  any guarded route hung server-side rendering forever (`ng serve` with SSR
  never responded for `/signin`, `/dashboard`, …). The guards now pass
  immediately on the server platform — the page shell renders and the client
  re-runs the guard after hydration; route data stays protected by the API.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`54adeb2`](https://github.com/SixthSummit/ship-angular/commit/54adeb278bdcc5a7b1153cfa73b298a604b5d24c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Enable `noUncheckedIndexedAccess` throughout framework, schematics, documentation, and newly
  generated application TypeScript projects so unchecked map and array access is not treated as
  always present.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`1370221`](https://github.com/SixthSummit/ship-angular/commit/137022144ca537d35ae487d098550cb3d374ad9c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare the Angular runtime helper dependency explicitly so clean, strict workspace installs build the package without relying on npm hoisting.

- [#2](https://github.com/SixthSummit/ship-angular/pull/2) [`ebf04d7`](https://github.com/SixthSummit/ship-angular/commit/ebf04d7ec7e48f8f5f4d0a22b34529c1ec25453f) Thanks [@selosindis](https://github.com/selosindis)! - Make the scaffold's "MSW dev mode" story actually work end-to-end, fixing
  everything the activated e2e tripwire surfaced:

  - `ship-angular add` now accepts multiple modules (`add auth dashboard
landing`); previously only the first argument was installed
  - landing + auth + core modules: type-only exports/imports (`FaqItem`,
    `Avatar`, `Feature`, `Routes`, `OnInit`) now use `type` modifiers — they
    failed to compile in consumer apps under `verbatimModuleSyntax`
  - the template now ships `public/mockServiceWorker.js` (+ `msw.workerDirectory`)
    — without it MSW's browser worker could never start
  - the strict nonce CSP in `server.ts` is production-only: Vite's dev server
    injects its scripts without nonces, so the CSP blocked the entire client
    app in `ng serve` (no hydration, no interactivity)
  - e2e tripwire specs are module-aware: auth/dashboard/landing specs skip
    cleanly on a bare scaffold (with instructions) instead of failing against
    the welcome-page fallthrough, and a new welcome spec keeps real coverage
    pre-modules

## 4.0.0-alpha.3

### Patch Changes

- [#7](https://github.com/SixthSummit/ship-angular/pull/7) [`537f51d`](https://github.com/SixthSummit/ship-angular/commit/537f51d4d9295bbae86d11ae23ca65a709b0fdf4) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Fix the generated Playwright configuration so new projects pass TypeScript checking with exact optional property types enabled. CI still uses one worker; local runs use Playwright's default worker count.

## 4.0.0-alpha.2

### Major Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`df78c5d`](https://github.com/SixthSummit/ship-angular/commit/df78c5d48040222dbf4a47a72e77fb3a4e4f0dc6) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Replace mandatory provider-specific AuthAdapter methods with discoverable auth capabilities and add an indeterminate identity state for transport and protocol failures.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fe0c187`](https://github.com/SixthSummit/ship-angular/commit/fe0c187894d96f05b1e360b6dd15daa706a9250b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Replace the URL-driven SessionAuthAdapter with an operation-backed session adapter in the auth entrypoint. Session initialization is explicit, failed logout preserves authenticated state, and network/protocol uncertainty becomes indeterminate rather than signed out.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fda9c1a`](https://github.com/SixthSummit/ship-angular/commit/fda9c1abeb54e3eac466ec5b062d38d92f47abd7) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Remove the uncompiled bundled module and library catalogs, keep feature generation app-owned under `src/app/modules`, make template rendering deterministic across every schematic, and make `--current-dir` refuse to delete or overwrite an existing project.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`ff572b6`](https://github.com/SixthSummit/ship-angular/commit/ff572b6b9c3448f8cfbd7b987e3dcb7a60ac1ed4) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an operation-session-auth schematic that generates contract-checked operation bindings and requires an application-owned identity decoder instead of casting unknown server data.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`bf712a8`](https://github.com/SixthSummit/ship-angular/commit/bf712a8a434b81757ab81ef59dc0efa9e080d707) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Generate structural operation-client boundaries, operation-backed upload and stream integrations, capability-based auth adapters, and a pnpm/Biome/Angular-ESLint application scaffold. Publish the framework ESLint plugin and share one request-scoped operation policy between generated clients and transports.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`a380ebd`](https://github.com/SixthSummit/ship-angular/commit/a380ebd846b510be342585bbf0b42a481ed90958) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Move `FirebaseAuthAdapter` from the package root to the optional `/firebase-auth` entrypoint and require explicit asynchronous adapter initialization so provider listeners do not start during construction and initialization failures remain honest, redacted auth state.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`fc05681`](https://github.com/SixthSummit/ship-angular/commit/fc05681c810296f68826126096419cfc17a373dd) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dry-run-first CLI codemod for deterministic framework entrypoint imports. Firebase auth moves safely to its optional entrypoint while session auth and behavioral mappings remain explicit manual work.

### Minor Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`f2b4c8d`](https://github.com/SixthSummit/ship-angular/commit/f2b4c8d04ba74ca9a2f7bbd3141870ebc4d659bc) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an explicit operation stream resource with generated request/event decoding, shared credentials and pre-stream error policy, bounded event history, sticky event IDs, approved reconnect behavior, current credentials on reconnect, cancellation, timeouts, and stale-reader protection.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`7c59c06`](https://github.com/SixthSummit/ship-angular/commit/7c59c063569bcb324fa91427b0fdfbdd27ea9d9d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the `/download` operation capability with generated request bindings, exact byte and stream preservation, declared JSON error decoding, response metadata and safe filename handling, shared authentication/request/retry policy, cancellation, timeout, stale-result protection, and origin enforcement.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`39cd955`](https://github.com/SixthSummit/ship-angular/commit/39cd9552cfa63cf07a13586f1bd7f58ef5f518ea) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add operation-resource and operation-mutation schematics that generate contract-inferred Angular
  wrappers without URLs, Hono coupling, untyped values, or message-based error handling.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8a733c9`](https://github.com/SixthSummit/ship-angular/commit/8a733c91a660db0adba3eb7fd5d48b840930e2dd) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the `/forms` operation integration with generated client-safe field bindings, typed Angular controls, explicit optional-field presence, stable validation issues, server issue mapping, and lossless date and bigint codecs without importing backend schema runtimes.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`3107319`](https://github.com/SixthSummit/ship-angular/commit/3107319dcee1d20785a32a12087446eebc466b96) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a non-mutating CLI migration audit that inventories legacy client, auth, error, serialization,
  transport, schema, and Angular DI patterns without guessing operation mappings or exposing source
  contents in its report.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`6836f3f`](https://github.com/SixthSummit/ship-angular/commit/6836f3fb088fd986038b3b01d66722eb1dc72cf1) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add generated-binding-first schematics for downloads, sockets, signed uploads, and operation forms. Socket and signed-upload origins remain required caller policy rather than permissive generated defaults.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`d1b7653`](https://github.com/SixthSummit/ship-angular/commit/d1b765357faf5e2d3bc5179681b85635dc319b8a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add an isolated Hono v4 compatibility adapter that maps legacy route-tree calls into typed operation results without adding Hono to the operation kernel.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`6a4ffc1`](https://github.com/SixthSummit/ship-angular/commit/6a4ffc16d13d239f6ae287073cb98ec98726d3ca) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a temporary `/legacy-rest` operation adapter for pinned applications that predate the Hono
  integration. App-owned mappings retain legacy URL construction while ShipAngular preserves typed
  results, response metadata, declared and unknown errors, cancellation, and shared request policy.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`e6539cc`](https://github.com/SixthSummit/ship-angular/commit/e6539cc3febb5d52f3ce870e481f7554e224b2d8) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Export a test-runner-independent operation-client conformance assertion and require packed,
  browser-safe contract boundary verification in CI.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`265b2a5`](https://github.com/SixthSummit/ship-angular/commit/265b2a54e110f159fac622b1ed96c4435ab5be3a) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Accept ShipAPI's canonical nested operation type contract and add an import-free `/ship-api`
  adapter for its structural HTTP client and runtime manifest. The adapter preserves typed
  statuses, errors, request/response metadata, per-operation credential modes, unknown
  additive fields, 304 cache results, cancellation, and safe exceptional diagnostics.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`c5c4a0f`](https://github.com/SixthSummit/ship-angular/commit/c5c4a0fa4c169c5c87dca2c4fcf30ac18e6e72aa) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a typed signed-upload state machine that composes declared sign and completion operations with an origin-isolated provider transfer, cancellation, progress, advisory file validation, safe provider errors, and stale-callback protection.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`2ff4661`](https://github.com/SixthSummit/ship-angular/commit/2ff4661d3c4f906e8fd7fa5b3ec84f188657f2d6) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add the browser-safe structural operation contract, typed Angular provider and sanitized SSR context, operation-aware credential/request/retry policy, status-indexed result types, lossless application error parsing, response metadata, presentation adaptation, and exceptional transport, protocol, timeout, and cancellation errors under the new `/operations` entrypoint.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`56a0248`](https://github.com/SixthSummit/ship-angular/commit/56a0248f20d8496957130ec115b751c89bd1093c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a typed `/upload` operation capability with generated multipart bindings, shared credentials and CSRF policy, advisory file constraints, progress signals, lossless expected errors, conservative retries, auth refresh, cancellation, timeouts, and stale-callback protection.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`dd8fb16`](https://github.com/SixthSummit/ship-angular/commit/dd8fb1683ee758451b2927985deb53a52ebdcdac) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dedicated `/stream` entrypoint with a cancellation-aware WHATWG SSE parser that handles arbitrary UTF-8 chunks, CR/LF boundaries, multiline data, sticky event IDs, and valid reconnect hints.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`eba8351`](https://github.com/SixthSummit/ship-angular/commit/eba8351236106866cb3903721bbc86b61ea87d94) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add a dedicated `/socket` operation capability with typed connection and message codecs, optional operation-backed tickets, exact origin and query credential guards, explicit send outcomes, bounded queues/history, declared close/reconnect policy, fresh tickets on reconnect, and inert SSR behavior.

### Patch Changes

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`f38c218`](https://github.com/SixthSummit/ship-angular/commit/f38c2189953d6388310c313b6873e47093c44245) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Validate operation IDs, identifiers, package specifiers, names, and destination paths before rendering operation-oriented schematics so malformed or injected options cannot become generated TypeScript.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`7057467`](https://github.com/SixthSummit/ship-angular/commit/7057467ab4639b01bce258597a837e0f1caa279b) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Add company Conventional Commit, pull request, and reviewed-testing guidance to newly generated projects.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`dfe21bf`](https://github.com/SixthSummit/ship-angular/commit/dfe21bfeb2bf3fc68f2620dee0aff8e747be3794) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Preserve status, response bodies, request IDs, structured codes/details, and readable headers when the generic REST client fails, and correctly forward binary response and progress options to Angular HttpClient.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`a25bc1e`](https://github.com/SixthSummit/ship-angular/commit/a25bc1e550c5c3d5e6a4b56452394ca3fa732920) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Enable exact optional property checking across framework, schematics, documentation, and generated application TypeScript projects.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8f38fbe`](https://github.com/SixthSummit/ship-angular/commit/8f38fbe6ee1fe8ef0d4b887e1eab4e088fc3416d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Refresh the framework's runtime dependency ranges and the workspace's Angular, Firebase, documentation and build dependency resolutions. The checked-in workspace now passes the high/critical dependency audit, which is enforced in CI and the local verification command. Consumers should refresh their own lockfiles and audit their installed dependencies; Angular and Firebase remain peer dependencies owned by the consuming application.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`8f38fbe`](https://github.com/SixthSummit/ship-angular/commit/8f38fbe6ee1fe8ef0d4b887e1eab4e088fc3416d) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Reject download redirects before credentials can cross origins. Preserve cancellation through streamed download completion, mutation caller signals and socket tickets. Keep automatic session refresh within the initiating action. Close protocol-invalid WebSockets with browser-valid application code 4002 and reject invalid close overrides.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`54adeb2`](https://github.com/SixthSummit/ship-angular/commit/54adeb278bdcc5a7b1153cfa73b298a604b5d24c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Enable `noUncheckedIndexedAccess` throughout framework, schematics, documentation, and newly
  generated application TypeScript projects so unchecked map and array access is not treated as
  always present.

- [#5](https://github.com/SixthSummit/ship-angular/pull/5) [`1370221`](https://github.com/SixthSummit/ship-angular/commit/137022144ca537d35ae487d098550cb3d374ad9c) Thanks [@HaruHunab1320](https://github.com/HaruHunab1320)! - Declare the Angular runtime helper dependency explicitly so clean, strict workspace installs build the package without relying on npm hoisting.

## 4.0.0-alpha.1

### Major Changes

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Remove the legacy entity/model layer from the published surface:
  `AbstractEntityService`, the ORM-style models (`Account`, `Entity`,
  `Permission`, `Role` + their interfaces), and the legacy top-level interfaces
  (`AssetResponse`, `AuthError`, `PaginatorOptions`, `SearchOptions`). Data
  access on the 4.0 line is `createResource()` + the typed `hc()` client;
  schema-driven forms come from `createSchemaForm()`.

### Minor Changes

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Ship the Sherpa QA-handoff surface and mirror it into the project template:
  the `/ship:sherpa-brief` slash command, the read-only `qa-brief` subagent,
  the app-developer skills (`add-page`, `add-protected-route`,
  `add-auth-adapter`), and a `sherpa-brief.yml` GitHub Action that posts a QA
  brief as a sticky PR comment and to Slack on merge. The headless CI path is
  hardened: read-only `--allowedTools`, heredoc-delimited step outputs, and
  diff/PR text treated as untrusted data.

### Patch Changes

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`bf9e39b`](https://github.com/SixthSummit/ship-angular/commit/bf9e39bdde0674cfe40a3148c736afe797bb9bf5) Thanks [@selosindis](https://github.com/selosindis)! - Security dependency sweep — `npm audit` now reports 0 vulnerabilities. The
  framework builds against Angular 20.3.24 (clears the compiler XSS advisories
  GHSA-jrmj-c5cx-3cw6 / GHSA-g93w-mfhg-p222), and the project template now
  scaffolds vitest 4 (`^4.0.0`), clearing the vitest UI-server advisory
  (GHSA-5xrq-8626-4rwp) for generated apps. Peer ranges are unchanged —
  existing apps on `^20.0.0` resolve to patched Angular automatically.

  Template fixes that ride along: an `overrides` entry pins vitest past
  `@angular/build`'s `peerOptional vitest ^3.1.1` (Angular 20 hasn't widened it
  yet); `test-setup.ts` installs Web Streams polyfills before `msw/node` loads
  and imports `@angular/localize/init`; and the zoneless change-detection
  provider moved from `beforeAll` to `beforeEach` so it survives TestBed resets
  — a fresh scaffold now installs, type-checks, tests, and builds clean.

- [#1](https://github.com/SixthSummit/ship-angular/pull/1) [`6aeda63`](https://github.com/SixthSummit/ship-angular/commit/6aeda634ec6f13da86c8b7932859a422c7a6fa46) Thanks [@selosindis](https://github.com/selosindis)! - Fix `ng add` / `ng generate`: the schematics compile to CommonJS inside a
  `"type": "module"` package, so the Angular CLI resolved every factory to
  `undefined`. A nested `schematics/package.json` (`{"type": "commonjs"}`) pins
  the subtree back to CJS, guarded by the build and a factory-loading
  regression spec. Also makes `defineEnv` compatible with zod 4 (structural
  `EnvSchemaLike` instead of the removed `ZodTypeDef`), matching the advertised
  `zod ^3.23 || ^4` peer range.

- [#2](https://github.com/SixthSummit/ship-angular/pull/2) [`ebf04d7`](https://github.com/SixthSummit/ship-angular/commit/ebf04d7ec7e48f8f5f4d0a22b34529c1ec25453f) Thanks [@selosindis](https://github.com/selosindis)! - Fix an SSR deadlock in `authGuard` / `noAuthGuard`: both guards wait for the
  auth state to leave `'unknown'`, but no auth adapter runs on the server, so
  any guarded route hung server-side rendering forever (`ng serve` with SSR
  never responded for `/signin`, `/dashboard`, …). The guards now pass
  immediately on the server platform — the page shell renders and the client
  re-runs the guard after hydration; route data stays protected by the API.

- [#2](https://github.com/SixthSummit/ship-angular/pull/2) [`ebf04d7`](https://github.com/SixthSummit/ship-angular/commit/ebf04d7ec7e48f8f5f4d0a22b34529c1ec25453f) Thanks [@selosindis](https://github.com/selosindis)! - Make the scaffold's "MSW dev mode" story actually work end-to-end, fixing
  everything the activated e2e tripwire surfaced:
  - `ship-angular add` now accepts multiple modules (`add auth dashboard
landing`); previously only the first argument was installed
  - landing + auth + core modules: type-only exports/imports (`FaqItem`,
    `Avatar`, `Feature`, `Routes`, `OnInit`) now use `type` modifiers — they
    failed to compile in consumer apps under `verbatimModuleSyntax`
  - the template now ships `public/mockServiceWorker.js` (+ `msw.workerDirectory`)
    — without it MSW's browser worker could never start
  - the strict nonce CSP in `server.ts` is production-only: Vite's dev server
    injects its scripts without nonces, so the CSP blocked the entire client
    app in `ng serve` (no hydration, no interactivity)
  - e2e tripwire specs are module-aware: auth/dashboard/landing specs skip
    cleanly on a bare scaffold (with instructions) instead of failing against
    the welcome-page fallthrough, and a new welcome spec keeps real coverage
    pre-modules
