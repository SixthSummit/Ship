# Current ShipAPI v4 coupling map

> Audited baseline: ShipAngular `dev` at `a571978`. Purpose: inventory the current Hono/ShipAPI v4 coupling before any migration. Classification: **hard** means a type/runtime/API depends on the v4 path; **instructional** means docs, prompts, or evals teach or enforce it; **adjacent** means the surface is backend-neutral in principle but currently encodes v4 wire assumptions.

## Current dependency flow

```text
consumer ShipAPI package/source types
  -> Hono hc<typeof app> client
  -> provideShipApiClient<T>() global DI token
  -> arbitrary () => Promise<Response|T> thunk
  -> createResource / createStream / SessionAuthAdapter
  -> caller manually checks Response and throws ApiError

separate paths for the same request concerns
  Angular HttpClient -> functional interceptors
  Hono/raw fetch     -> withX(fetch) wrappers
  XHR upload         -> caller-built headers/credentials
  WebSocket          -> caller-built subprotocols
```

There is no declared ShipAPI runtime dependency in `../packages/angular/package.json`, and the packed FESM does not import Hono, Drizzle, Firebase Admin, PostgreSQL, or Node runtime modules. That is a good boundary to preserve. The coupling is nevertheless public and architectural because consumers are directed to import an application's Hono route-tree type and pass its client through ShipAngular's untyped seams.

## Published root API

All symbols below are exported from `../packages/angular/src/public-api.ts` and therefore ship from the single package root.

| Public symbols | Classification | Current dependency | Redesign disposition |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `provideShipApiClient`, `injectShipApiClient`, `SHIP_API_CLIENT`, `ShipApiClientFactory` | hard | Factory examples create `hc<ShipApiClient>()`; the shared token erases application type and passes raw Angular `Request | null` to user code. | Deprecate in favor of `createShipClientToken<TContract>` and `provideShipClient`; keep provider-factory/request-scope concept. |
| `createResource`, `ShipResource`, `CreateResourceOptions` | hard for thunk overload; generic for URL overload | An eagerly probed async thunk is the official `hc()` bridge. | Split `createOperationResource`, `createHttpResource`, and `createAsyncResource`; isolate/deprecate thunk probing. |
| `ApiError`, `ApiErrorCode`, `ApiErrorEnvelope`, `RateLimitError`, `parseRetryAfter` | adjacent | Hard-coded minimum ShipAPI envelope and status-to-code synthesis; callers must throw after `hc()` responses. | Preserve valid envelope data and presentation helper; add typed failed results, response metadata, `ProtocolError`, and `TransportError`. |
| `idempotencyInterceptor`, `withIdempotency`, tokens | adjacent | Duplicated HttpClient/fetch behavior with no operation metadata. | Keep third-party interceptor separately if useful; operation path uses one capability pipeline. |
| `rateLimitInterceptor`, `provideRateLimit`, `withRateLimit`, tokens/types | adjacent | Duplicated unconditional 429 retry policy. | Replace operation behavior with method/idempotency-aware retry; generic REST policy remains opt-in. |
| `requestIdInterceptor`, `withRequestId`, tokens | adjacent | Duplicated request-header generation, not tied to SSR/call metadata. | Operation pipeline creates/forwards request IDs and exposes response IDs. |
| `csrfTokenInterceptor`, `provideCsrf`, `withCsrf`, tokens/types | adjacent | Reads a cookie and attaches a header without ShipAPI-origin/auth-mode enforcement. | Bind to cookie-session capability and allowed origins. |
| `createStream`, `ShipStream`, status/options/decoder; `parseSseFrames`, `SseFrame` | hard for thunk; adjacent for URL | Accepts an already-created `hc()` response and assumes SSE/JSON framing outside contract metadata. | `OperationStreamClient` plus a separate generic URL stream; contract decoder/protocol and signal propagation required. |
| `createUpload`, `ShipUpload`, status/options | adjacent | v4 envelope parsing but no common auth/CSRF policy; docs require manual headers. | Keep XHR progress behind operation upload adapter; generic upload can remain separate. |
| `createSignedUpload`, types | adjacent | Caller provides an untyped sign thunk and provider upload details. | Model sign and completion as declared operations plus provider capability. |
| `createSocket`, types | adjacent | Defaults to handwritten `ship-api.v1`; caller composes auth subprotocols. | Derive protocol/message/close/reconnect metadata from socket capability; retain generic WebSocket helper separately if warranted. |
| `SessionAuthAdapter`, config | hard | Hard-coded `/auth/me`, `/auth/sign-out`, `/auth/refresh`, raw fetch, and v4 envelope handling. | Adapt structural auth operations and explicit cookie/bearer/CSRF capabilities. |
| `createSchemaForm`, `zodValidator`, form types | hard by documented integration; adjacent in source | Documentation consumes ShipAPI Drizzle/Zod server schemas; runtime structurally probes Zod-like schemas. | Consume a generated client-safe schema projection; optional Zod adapter isolated. |
| `ApiClient`, interfaces, `authInterceptor` | generic | Intended for REST but currently loses errors; auth behavior overlaps ShipAPI wrappers. | Retain under a third-party REST entrypoint and fix error preservation independently. |
| `AuthService`, `AuthAdapter`, `FirebaseAuthAdapter`, guards | generic | Frontend identity-provider boundary. | Retain; decompose optional actions and credentials rather than tying to Hono. |
| `OnlineService` | generic | Configurable URL/health assumptions only. | Retain and make it optionally consume operation health metadata. |
| pipes, logger, env, general types | unrelated | None. | Review as ordinary package-surface cleanup, not part of the ShipAPI migration. |

## Implementation sources

### Hard or adjacent core sources

| Path                                                                                               | Coupling/evidence                                                                               | Required action                                                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `../packages/angular/src/api/shipapi/provideShipApiClient.ts`                                      | ShipAPI-named global token and `ShipApiClientFactory<T>`; factory receives Angular request.     | Generalize, type the token, sanitize context.                                              |
| `../packages/angular/src/api/resource/createResource.ts`                                           | `hc()` documented thunk overload; eager mode probe; response unwrapping belongs to caller.      | Explicit resource constructors and operation result handling.                              |
| `../packages/angular/src/api/client/ApiClient.ts`                                                  | Generic REST client catches structured Angular failures and throws message-only `Error`.        | Preserve structured HTTP failure; keep independent from operations.                        |
| `../packages/angular/src/api/errors/ApiError.ts`                                                   | v4 error envelope, status mapping, `Retry-After`; malformed bodies become synthetic API errors. | Lossless application failures plus distinct protocol/transport errors.                     |
| `../packages/angular/src/api/interceptors/auth-interceptor.ts`                                     | HttpClient-only auth path and origin allowlist.                                                 | Keep for REST; operation credential capability becomes canonical for ShipAPI.              |
| `../packages/angular/src/api/interceptors/{csrf,idempotency,rate-limit,request-id}-interceptor.ts` | Each contains both an Angular interceptor and fetch wrapper.                                    | Collapse operation behavior into one pipeline; retain only explicitly generic REST pieces. |
| `../packages/angular/src/api/upload/createUpload.ts`                                               | XHR, manual headers/credentials, v4 error envelope parsing.                                     | Adapt XHR to prepared operation request and contract decoders.                             |
| `../packages/angular/src/api/upload/createSignedUpload.ts`                                         | Untyped `signRequest(file)` callback; no abort signal during signing.                           | Contract-declared signing operation and race-safe state machine.                           |
| `../packages/angular/src/api/stream/createStream.ts`                                               | URL or `hc()` promise probing; v4 errors; response can predate resource cancellation.           | Operation stream capability plus explicit generic stream.                                  |
| `../packages/angular/src/api/stream/sse-parser.ts`                                                 | Handwritten SSE wire behavior; documented sticky event ID is not implemented.                   | Protocol conformance fixture and corrected parser.                                         |
| `../packages/angular/src/api/socket/createSocket.ts`                                               | Handwritten `ship-api.v1`, auth subprotocol example, generic JSON assumptions.                  | Contract metadata/codec adapter and generic helper separation.                             |
| `../packages/angular/src/auth/adapters/SessionAuthAdapter.ts`                                      | Hard-coded ShipAPI v4 endpoints and raw fetch.                                                  | Structural auth operations/capabilities.                                                   |
| `../packages/angular/src/forms/createSchemaForm.ts`                                                | Structural Zod probing, unsafe type cast; docs tie it to ShipAPI schemas.                       | Generated browser-safe form-schema adapter.                                                |
| `../packages/angular/src/online/OnlineService.ts`                                                  | Documentation assumes ShipAPI `/health`; implementation is configurable and browser-safe.       | Keep generic; integration can provide a health operation.                                  |
| `../packages/angular/src/public-api.ts`                                                            | Makes every item above part of one root entrypoint/FESM.                                        | Add secondary entrypoints and staged compatibility exports.                                |

### Unit and integration tests

These tests encode current behavior and must be classified before migration rather than mechanically copied:

- `../packages/angular/src/api/resource/createResource.spec.ts`
- `../packages/angular/src/api/resource/createResource.shipapi-smoke.spec.ts` — hard source/workspace link and optional skip
- `../packages/angular/src/api/shipapi/provideShipApiClient.spec.ts`
- `../packages/angular/src/api/client/ApiClient.spec.ts`
- `../packages/angular/src/api/errors/ApiError.spec.ts`
- `../packages/angular/src/api/interceptors/auth-interceptor.spec.ts`
- `../packages/angular/src/api/interceptors/csrf-interceptor.spec.ts`
- `../packages/angular/src/api/interceptors/idempotency-interceptor.spec.ts`
- `../packages/angular/src/api/interceptors/rate-limit-interceptor.spec.ts`
- `../packages/angular/src/api/interceptors/request-id-interceptor.spec.ts`
- `../packages/angular/src/api/upload/createUpload.spec.ts`
- `../packages/angular/src/api/upload/createSignedUpload.spec.ts`
- `../packages/angular/src/api/stream/createStream.spec.ts`
- `../packages/angular/src/api/stream/sse-parser.spec.ts`
- `../packages/angular/src/api/socket/createSocket.spec.ts`
- `../packages/angular/src/auth/adapters/SessionAuthAdapter.spec.ts`
- `../packages/angular/src/forms/createSchemaForm.spec.ts`

The reusable auth adapter suite under `../packages/angular/testing/` is backend-neutral and should stay. It needs sibling suites for operation clients, request policies, and transport capabilities.

## Generated and installation surfaces

### Schematics

| Schematic         | Current v4 assumption                                                                                                                         | Migration                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `api-client`      | `../packages/angular/schematics/api-client/files/api.ts` scaffolds `hc<ShipApiClient>()`; schema/index request an API type path and base URL. | Add a contract-package/provider schematic; retain legacy generator under an explicit `hono-v4` name during the window. |
| `stream`          | Generates the current URL/response-thunk `createStream` shape.                                                                                | Generate an operation ID and typed decoder/capability usage.                                                           |
| `upload`          | Generates current manual upload component/options.                                                                                            | Generate an operation upload capability and credential-free component code.                                            |
| `module` / `page` | Generates copied source under `modules/`.                                                                                                     | Reclassify as app-owned generators or replace reusable modules with compiled packages.                                 |

`../packages/angular/schematics/collection.json` descriptions are themselves contract documentation and must change with the APIs. `../packages/angular/src/schematics-factories.spec.ts` must fail when built schematic artifacts are missing rather than treating absence as success.

### CLI

`../packages/angular/cli/ship-angular.js` implements a second generator/install path alongside Angular schematics. It copies module sources, mutates routes using textual patterns, deletes an existing module under `--force`, and can remove `node_modules`/`package-lock.json` in current-directory creation. The target CLI should be a thin, tested wrapper over schematics/migrations/diagnostics. Destructive targets must be resolved and confirmed explicitly.

### Starter template

Direct v4 references are present in:

- `../packages/angular/templates/default/README.md`
- `../packages/angular/templates/default/.claude/skills/add-auth/SKILL.md`
- `../packages/angular/templates/default/.claude/skills/add-page/SKILL.md`

The template also lacks the custom ShipAngular ESLint configuration it claims the framework enforces. Its generated application, not only its README, must be tested from the packed package against both a browser-safe contract fixture and independent REST calls.

## Modules

The following module records teach `createResource`, ShipAPI, schema, stream, upload, or backend wiring and must be reviewed when their ownership model is fixed:

- `modules/admin/MODULE.md`
- `modules/ai/MODULE.md`
- `modules/ai/services/ai-client.service.ts`
- `modules/auth/MODULE.md`
- `modules/billing/MODULE.md`
- `modules/billing/module.json`
- `modules/billing/services/billing.service.ts`
- `modules/dashboard/MODULE.md`
- `modules/forms/MODULE.md`
- `modules/forms/module.json`
- `modules/forms/components/file-upload-field.component.ts`
- `modules/landing/MODULE.md`
- `modules/notifications/MODULE.md`
- `modules/profile/MODULE.md`
- `modules/store-example/MODULE.md`
- `modules/store-example/module.json`
- `modules/team/MODULE.md`

`modules/ai` is a hard architecture problem, not just stale prose: it implements provider fetch/SSE logic and browser-executed tool callbacks that should live behind ShipAPI operations. `modules/forms` directly advertises consuming a ShipAPI Drizzle/Zod schema. `modules/billing` documents both current REST and Hono thunk variants.

## Documentation and agent-control surfaces

### Canonical repository instructions

- `AGENTS.md` locks Hono `hc()` as the primary contract and tells agents not to relitigate it without the current contract record.
- `CLAUDE.md` repeats the ShipAPI v4 integration surface.
- `.cursor/rules/architecture.mdc` and `.cursor/rules/conventions.mdc` make the Hono thunk the preferred resource shape.
- `../packages/angular/CLAUDE.md` describes a manual sibling package-link smoke workflow and places joint CI outside the current scope.

The new ADR provides the required explicit supersession. These control files must be updated in the same commit that activates the new architecture, not before acceptance and not left stale afterward.

### Agent skills and agents

Hard/instructional coupling appears in:

- `.claude/skills/connect-shipapi/SKILL.md`
- `.claude/skills/migrate-rest-to-hono/SKILL.md`
- `.claude/agents/ship-architect.md`
- `.claude/agents/module-author.md`
- `.claude/agents/qa-brief.md`
- `.claude/commands/sherpa-brief.md`
- `.claude/plugin.json`
- `.claude/skills/add-module/SKILL.md`
- `.claude/skills/release-beta/SKILL.md`

`connect-shipapi` is a correctness risk today because it recommends global `autoRetry: true`. `migrate-rest-to-hono` should become a legacy-to-operation-contract migration skill, not a permanent REST-to-route-tree migration.

### Product and API docs

The files below either lock Hono, teach v4 integration, describe the envelope/capabilities, or promise enforcement that affects the redesign:

- `README.md`
- `SECURITY.md`
- `docs/README.md`
- `docs/INTERIM_BACKEND.md`
- `docs/ROADMAP.md`
- `docs/api/LIBRARY_EXPORTS.md`
- `docs/architecture/AUTHENTICATION.md`
- `docs/architecture/CONTRACT.md`
- `docs/architecture/FRAMEWORK_OVERVIEW.md`
- `docs/architecture/MODULE_SYSTEM.md`
- `docs/development/CLI_REFERENCE.md`
- `docs/development/CREATING_MODULES.md`
- `docs/getting-started/CONFIGURATION.md`
- `docs/getting-started/INSTALLATION.md`
- `docs/getting-started/PROJECT_STRUCTURE.md`
- `docs/getting-started/QUICK_START.md`

`docs/architecture/CONTRACT.md` remains the historical decision. Do not rewrite its 2026-05-08 resolution as if it never happened; add a superseded notice after ADR 0002 is accepted. `docs/api/LIBRARY_EXPORTS.md` needs source/example conformance because several described properties and enum members do not exist.

### Evaluations

The agent eval surface encodes the old public shape:

- `evals/README.md`
- `evals/agent-tasks/eval-001-add-module/brief.md`
- `evals/agent-tasks/eval-005-streaming-chat/{brief.md,grade.sh}`
- `evals/agent-tasks/eval-006-websocket-subscription/{brief.md,grade.sh}`
- `evals/agent-tasks/eval-007-file-upload/{brief.md,grade.sh}`
- `evals/agent-tasks/eval-008-session-auth/{brief.md,grade.sh}`
- `evals/agent-tasks/eval-009-idempotency-and-rate-limit/{brief.md,grade.sh}`

These should become behavioral evaluations over stable operations and capabilities. Graders should inspect compiled behavior/tests rather than rewarding exact use of obsolete symbol names.

## Build, dependency, and release coupling

| File/surface                    | Current fact                                                                               | Redesign relevance                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `package.json`                  | npm workspaces include only `packages/*` and `apps/*`; Turbo is already installed.         | Do not add what exists; decide package boundaries first.                                             |
| `package-lock.json`             | Contains extraneous sibling ShipAPI/link records and their server dependency metadata.     | Replace through the isolated pnpm migration; until then, treat lock-based browser audits cautiously. |
| `knip.json`                     | Ignores `modules/**`, `libraries/**`, and apps in the root project.                        | Every shipped surface must enter a real analyzed project.                                            |
| `turbo.json`                    | Generic tasks create nonexistent workspace commands and unnecessary dependencies.          | Repair after target workspaces exist; retain only with cache/timing value.                           |
| `scripts/build-core.js`         | Copies modules/libraries into the package and logs copy errors instead of failing.         | Make packaging atomic and fatal on omissions.                                                        |
| `scripts/ci-check.sh`           | Invokes nonexistent root `build-prod`.                                                     | Delete or make the root `ci` graph authoritative.                                                    |
| `.github/workflows/ci.yml`      | Normal tests are required; security audit is `continue-on-error`; no packed joint fixture. | Add mandatory packed contract/browser checks and deliberate security policy.                         |
| `.github/workflows/e2e.yml`     | Packed scaffold proof is limited to selected pushes, not normal PR/dev integration.        | Run a focused clean-consumer fixture in PRs and full browser matrix at an appropriate cadence.       |
| `.github/workflows/release.yml` | Changesets publish core but do not prove ShipAPI artifact compatibility.                   | Gate release on exact packed fixture manifest/hash.                                                  |

## Migration bookkeeping

For every item in this map, implementation PRs must choose one of four labels:

- **retain-generic** — independent REST/frontend behavior remains, with its own contract;
- **migrate-operation** — replace v4 assumptions with graph-derived operation/capability behavior;
- **compat-hono-v4** — keep only in the named compatibility entrypoint for the agreed window;
- **remove** — obsolete, unsafe, duplicated, or unsupported surface.

No item should be silently reinterpreted. In particular, historical docs are superseded by an ADR, public exports receive changesets/deprecations, eval graders move with the intended behavior, and optional tests are replaced only when mandatory packed tests are running.
