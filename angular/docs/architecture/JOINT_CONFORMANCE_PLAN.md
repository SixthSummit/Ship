# ShipAngular and ShipAPI joint conformance plan

> Status: Real generated unary/form packed gate complete (2026-09-08); expanded C1 non-JSON/advanced-codec/server-retry matrix remains open.
> Principle: test packed artifacts at the browser boundary; never depend on sibling source or a
> live production service.

## ShipAngular implementation status

The Angular-side packed harness now lives under `conformance/` and runs with
`pnpm test:packed-conformance`. CI packs the framework plus a synthetic, browser-safe contract/client
pair, compiles strict positive and negative consumers, scans public runtime artifacts, and runs a
shared operation-client assertion. The companion `pnpm test:browser-conformance` gate repacks the
exact build into a strict public consumer and runs cross-origin upload, download, SSE, and WebSocket
fixtures in Chromium. `pnpm test:joint-conformance` is the no-fallback entrypoint for a
ShipAPI-produced manifest. The command now defaults to the checksum-pinned real producer bundle in
`conformance/joint/artifacts/` and is required in browser CI. Its strict consumer, real HTTP and
Chromium tests and concurrent Angular request-injector and overlapping SSR document tests, plus real cookie refresh/replay, pass against the generated artifacts.
See `conformance/joint/README.md` for exact coverage and explicitly deferred capabilities. The full
matrix below is a roadmap, not a claim that all rows now pass against backend-generated bindings.

The ShipAPI checkout inspected at `059229c` now contains the isolated
`@sixthsummit/ship-contract` package, resolving the former requirement to install the server
monolith merely to obtain the structural protocol. That source-level package decision is accepted;
it does not replace the exact manifest and tarball execution required by C1.

The synthetic client's independently derived generic return type exposed a TypeScript assignability
limit: two packages can calculate equivalent status-indexed conditional result types yet fail generic
method assignment. The coordinated fixture must decide one canonical type-utility owner (recommended:
the browser-safe contract/client protocol package) or emit a compatible public client signature. Do
not solve this with `any`, a double cast, or an Angular dependency in the ShipAPI artifact.

## Goal

The suite proves that a ShipAPI operation graph can produce a client-safe artifact that ShipAngular consumes in a clean Angular browser/SSR application without Hono route-tree types or server-runtime dependencies.

It is not one large end-to-end test. It is a shared fixture version exercised at four boundaries:

```text
ShipAPI operation declarations
  -> deterministic graph + client projection tests
  -> packed browser contract/client tarballs
  -> ShipAngular type/runtime conformance package
  -> packed Angular browser and SSR fixture app
```

The required suite must fail, not skip, when an artifact is unavailable or incompatible.

## Artifact ownership

### ShipAPI owns

1. **Fixture operation graph.** A deliberately small application containing every required transport and policy case.
2. **Browser contract package.** Type declarations, serializable runtime metadata/codecs, deterministic graph hash, and no Node/server imports.
3. **Default HTTP operation-client package.** The structural `call(operationId, input, options)` implementation used by the fixture.
4. **Wire fixtures.** Valid and invalid error envelopes, validation issues, headers, binary bodies, SSE chunks, socket frames/close codes, and codec examples.
5. **Local fixture server.** A deterministic development-only server package or executable. It is not imported by the Angular application bundle.
6. **Projection tests.** Graph validation, stable output, semantic contract diff classification, and direct-operation/Hono-adapter parity.

ShipAPI publishes or uploads the fixture packages exactly as consumers receive them. It does not ask ShipAngular CI to clone/import ShipAPI source.

### ShipAngular owns

1. **Structural client conformance runner.** Runs the same unary result/metadata/cancellation cases against the default operation client, `HonoV4ClientAdapter`, and `LegacyRestClientAdapter` where supported.
2. **Angular resource/provider conformance.** Signal tracking, stale suppression, injection scope, SSR context, and presentation-error adaptation.
3. **Browser transport conformance.** XHR progress, downloads, SSE body reading, WebSockets, CORS-visible headers, cancellation, and reconnect behavior in a real browser.
4. **Clean packed consumer.** Installs only registry/tarball artifacts into a generated Angular application and builds browser and server bundles.
5. **Bundle and dependency proof.** Fails on server-only imports, unexpected entrypoint weight, or tree-shaking regressions.
6. **Compatibility tests.** Proves the v4 adapter obeys the new frontend seam and records unsupported capabilities explicitly.

### Jointly versioned fixture manifest

CI exchanges one machine-readable manifest with at least:

```json
{
  "fixtureProtocolVersion": 1,
  "graphHash": "sha256:...",
  "contractPackage": {
    "name": "@sixthsummit/ship-api-conformance-contract",
    "version": "0.0.0-fixture",
    "tarball": "...",
    "sha256": "..."
  },
  "clientPackage": {
    "name": "@sixthsummit/ship-api-client",
    "version": "0.0.0-fixture",
    "tarball": "...",
    "sha256": "..."
  },
  "wireFixtureVersion": 1
}
```

The exact names are open, but the graph hash, package versions, and tarball checksums are mandatory. ShipAngular records the consumed manifest in CI output so a failure is reproducible.

## Fixture operation inventory

The ShipAPI graph should declare stable operations equivalent to:

| Operation/capability                                 | Cases represented                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `accounts.get`                                       | path parameter, optional query, 200, auth/authz/not-found errors, ETag                              |
| `accounts.search`                                    | query arrays/nested encoding, empty vs omitted vs null, branded ID/date/decimal codec examples      |
| `accounts.create`                                    | body validation, 201, unsafe mutation, idempotency support, replay metadata                         |
| `accounts.delete`                                    | 204 with no body                                                                                    |
| `session.me` / `session.refresh` / `session.signOut` | cookie and bearer modes, CSRF, refresh, denial, state-honesty cases                                 |
| `public.status`                                      | explicitly anonymous call                                                                           |
| `rateLimit.safe` / `rateLimit.mutation`              | Retry-After date/seconds, retry permission, idempotency requirements                                |
| `reports.download`                                   | JSON pre-body error, Blob/ArrayBuffer/stream bytes, MIME/disposition/filename                       |
| `assets.upload`                                      | multipart fields, count/type/size constraints, progress, cancellation, declared server rejection    |
| `assets.signUpload` / `assets.completeUpload`        | two-operation signed provider flow and abort/race cases                                             |
| `events.watch`                                       | SSE comments, multiline/split UTF-8 frames, IDs, completion, reconnect permission, pre-stream error |
| `chat.socket`                                        | URL/protocol metadata, client/server message schemas, auth refresh, close-code/reconnect policy     |

Wire-fixture endpoints may deliberately return malformed JSON, HTML, missing exposed headers, delayed bodies, connection resets, and invalid protocol frames. These are transport test controls, not declared application operations.

## Required matrix

| Area                          | Required assertions                                                                                                                                                                                                                        | Primary owner | Execution layer                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| Contract determinism          | Identical graph produces byte-stable artifact/hash; semantic diff classifies input/output/error/policy changes.                                                                                                                            | ShipAPI       | unit + pack                                                        |
| Types                         | Valid IDs and inputs compile; unknown ID, wrong input location/type, omitted required field, impossible success status, and undeclared error code fail compilation.                                                                        | joint         | `tsc` positive/negative fixture projects                           |
| Structural seam               | Generated named method, if present, delegates consistently to `call`; ShipAngular depends only on structural types.                                                                                                                        | joint         | type + unit                                                        |
| Package boundary              | Contract/client tarballs contain no Hono app type, server handler, Drizzle, database, provider runtime, Node builtin, Firebase Admin, OpenTelemetry server SDK, or source/workspace link. Browser bundle cannot resolve them transitively. | joint         | tarball inspection + esbuild/Angular stats + forbidden-import scan |
| Success                       | 200, 201, and 204; status-indexed data; no attempted JSON parse for 204; null/omitted/empty remain distinct; codecs round-trip.                                                                                                            | joint         | unit + browser                                                     |
| Declared errors               | Authentication, authorization, validation, not found, conflict, rate limit, and declared server errors return `{ ok: false }` with exact status/code/details/metadata. Unknown additive fields survive.                                    | joint         | unit + browser                                                     |
| Transport/protocol errors     | DNS/connection reset, abort, timeout, invalid JSON, wrong content type, HTML proxy body, and malformed envelope are not fabricated declared API errors. Safe diagnostic body snippets are bounded/redacted.                                | ShipAngular   | unit + browser                                                     |
| Validation                    | Stable `details.issues` entries contain string/number paths, optional machine codes, and safe messages; unknown additive detail fields survive.                                                                                            | joint         | fixture + form unit/browser                                        |
| Response metadata             | `X-Request-Id`, `Retry-After`, ETag, content type/disposition, and idempotency replay/result metadata remain available on success/failure as applicable.                                                                                   | joint         | unit + browser                                                     |
| CORS                          | Browser can read every promised metadata header; missing `Access-Control-Expose-Headers` yields a specific configuration diagnostic.                                                                                                       | joint         | real browser against fixture server                                |
| Bearer auth                   | Current token is read for every attempt; one modeled refresh can update it; tokens never enter query strings, logs, thrown messages, or snapshots.                                                                                         | ShipAngular   | unit + browser redaction tests                                     |
| Cookie auth                   | Correct credentials mode; CSRF only on allowed origins/mutating declared operations; no CSRF/bearer header on unrelated third-party calls.                                                                                                 | joint         | browser + request capture                                          |
| SSR auth/context              | Only approved cookies/request ID/locale/trace headers forward; no browser globals; server-safe origin; abandonment cancels work.                                                                                                           | ShipAngular   | Angular SSR fixture                                                |
| SSR isolation                 | Concurrent user A/B renders cannot share cookies, bearer tokens, request IDs, locale, result cache, or abort state.                                                                                                                        | ShipAngular   | deterministic concurrent SSR test                                  |
| Request ID                    | Existing approved ID forwards; otherwise one is generated; response ID wins as server correlation ID; value appears in safe diagnostics.                                                                                                   | joint         | unit + browser/SSR                                                 |
| Idempotency                   | Key format/forwarding is stable per logical attempt; replay metadata preserved; non-declared operation rejects idempotency/retry configuration where possible.                                                                             | joint         | unit + server request capture                                      |
| Retry                         | Safe approved call obeys `Retry-After`; unsafe mutation never retries without declared support and stable key; auth/authz is not backoff-retried; body replayability checked; delay aborts immediately.                                    | joint         | fake clock unit + fixture server                                   |
| Cancellation/timeout          | Caller, resource supersession, timeout, destroy, SSR abandon, XHR abort, stream cancel, and reconnect cancel reach actual I/O and cannot publish stale state.                                                                              | ShipAngular   | unit + browser/SSR                                                 |
| Resource reactivity           | Signals read by input factory retrigger; no constructor-time I/O; newest generation wins; reload semantics and previous-value policy are explicit; application and exceptional failures remain distinguishable.                            | ShipAngular   | Angular unit                                                       |
| Mutations/optimism            | Optimistic apply/rollback/reconcile is explicit; failed mutation cannot be automatically duplicated; cancellation outcome is deterministic.                                                                                                | ShipAngular   | Angular unit                                                       |
| Cache                         | ETag forwarded as `If-None-Match`; 304 preserves the prior successful typed value and updates available metadata without parsing an empty body.                                                                                            | joint         | unit + browser                                                     |
| Upload                        | Field names/count/type/size constraints exposed; browser checks are advisory; XHR progress monotonic; shared auth/CSRF policy applies; abort/reset/destroy and overlapping starts are race-safe; JSON error parsed before success type.    | ShipAngular   | unit + browser                                                     |
| Signed upload                 | Signing operation accepts abort; late sign response cannot revive canceled/superseded upload; provider request excludes ShipAPI-only credentials unless declared; completion operation typed.                                              | joint         | unit + browser                                                     |
| Download                      | Exact bytes/status/MIME/disposition/filename preserved; JSON standard error parsed instead of returned as binary; Blob, ArrayBuffer, and stream modes tested.                                                                              | joint         | real browser                                                       |
| SSE/chunk stream              | UTF-8 and lines split across chunks; comments/multiline/event IDs; normal close vs abort vs network/protocol failure; body reader canceled; declared pre-stream error parsed; reconnect only when declared and safe.                       | joint         | parser unit + real browser                                         |
| WebSocket                     | URL/protocol/message codecs and close policy derive from metadata; token refreshed on reconnect; no query bearer; invalid messages visible as protocol errors; sends have explicit queue/reject semantics; buffers bounded; SSR inert.     | joint         | fake socket unit + real browser                                    |
| Hono v4 compatibility         | Supported unary JSON operations produce the same resource/result states as target client; unsupported codec/capability/signal behavior is explicit and diagnostic.                                                                         | ShipAngular   | shared conformance runner                                          |
| Legacy REST compatibility     | Synthetic legacy URL mappings preserve operation result/policy behavior; URL/serialization and discard-only cancellation limitations remain explicit.                                                                                      | ShipAngular   | shared conformance runner                                          |
| Third-party REST independence | Generic `ApiClient`/HTTP resource works with no ShipAPI package installed and does not inherit ShipAPI cookie/CSRF/idempotency policy.                                                                                                     | ShipAngular   | clean consumer unit/browser                                        |
| Logging/redaction             | No authorization, cookie, CSRF, provider raw error, unredacted validation value, upload body, or socket token in logs/errors/snapshots.                                                                                                    | joint         | logger sink + snapshot scan                                        |

## Type-test design

Use separate fixture programs rather than tests that merely contain casts:

- `valid-consumer/tsconfig.json` must compile with `noEmit`, strict optional/indexed checks, and only public package imports.
- `invalid-consumer/` contains one focused file per rejected use and runs with expected TypeScript diagnostic snapshots or `@ts-expect-error` at the exact expression.
- declaration/public API extraction verifies that ShipAngular does not accidentally publish an application contract, Hono `ClientResponse`, server type, or broad `any`.
- a skew fixture intentionally pairs incompatible graph/package versions and must produce a deterministic install/build/runtime diagnostic according to the accepted version policy.

The tests cover both type declarations and runtime metadata. Passing TypeScript alone cannot prove that codecs, policies, and graph hash match the deployed server.

## Browser and SSR harness

### Browser

Run Playwright against the packed Angular fixture and local fixture server. A real browser is required for CORS-exposed headers, cookie credentials, XHR progress, Blob/download behavior, ReadableStream, and WebSocket protocol negotiation. Unit fakes remain useful for exhaustive state-machine races and fake-clock retry tests.

The implemented local subset is `conformance/browser/` plus
`scripts/run-browser-conformance.mjs`. It deliberately imports the framework only from its
extracted tarball, binds the app and protocol fixture to separate loopback origins, records a
redacted request trace, and fails on unexpected browser console or network errors. It is
required in CI. Replacing its local typed contract with ShipAPI's packed generated contract
and fixture metadata remains joint work.

Each test receives a deterministic scenario ID header understood only by the fixture server. The server records a redacted request trace so assertions can prove attempt count, header inclusion, body identity, disconnect, and reconnect without inspecting secrets.

### SSR

Create a fresh Angular request injector for every render. Start at least two overlapping renders with distinct cookies, IDs, locales, delays, and cancellation times. Assert both HTML/result data and captured server traces. A platform singleton that closes over `REQUEST`, credential state, or cache must fail this case.

### No live systems

Firebase, Anthropic, Stripe, production ShipAPI, and real cloud storage are excluded. Provider-specific adapters get their own contract fakes. The suite is deterministic, offline after artifact acquisition, and suitable for pull requests.

## Bundle and schema experiments

Before choosing the form-schema representation, produce the same nontrivial form using:

1. the proposed JSON Schema/form metadata subset;
2. a browser-safe Zod projection;
3. a Standard Schema-compatible adapter if it materially differs.

Measure initial and lazy chunk gzip/brotli size, tree shaking when forms are unused, validation fidelity, transform/refinement handling, generated declaration size, and version-skew diagnostics. Reject any option that imports Drizzle or a server application runtime. Record unsupported async/server-only validation explicitly.

Set per-entrypoint budgets after the prototype; do not hide optional Zod/socket/upload cost in one aggregate root number.

## CI and release wiring

### ShipAPI pull request

1. validate/compile fixture graph;
2. run direct-execution and Hono-adapter parity;
3. generate twice and compare bytes/hash;
4. run contract semantic-diff tests;
5. pack contract/client/fixture-server artifacts;
6. scan tarballs for forbidden runtime imports;
7. run a minimal framework-neutral consumer;
8. publish artifacts and manifest for the paired ShipAngular workflow.

### ShipAngular pull request

1. acquire exact manifest/tarballs or use a reviewed pinned fixture revision;
2. install with a frozen lockfile into clean type/browser/SSR consumers;
3. run type, unit, lint/compiler, format, dependency, and public API checks;
4. run structural client plus Hono and legacy-REST compatibility conformance;
5. run browser and concurrent SSR suites;
6. build and inspect all secondary entrypoints and clean consumer bundles;
7. pack ShipAngular and reinstall that tarball into the fixture app;
8. fail on skipped required cases, fixture/hash mismatch, stale generated output, or forbidden imports.

### Release

The release candidate records the exact fixture protocol version and graph hash used. Changesets cannot publish a client/runtime change until the paired conformance matrix passes against packed artifacts. A nightly matrix may test compatible older/newer artifact versions, but the pull-request gate always tests at least the pinned contract and the candidate produced by a coordinated ShipAPI change.

## Replacing the existing smoke suite

The former `../packages/angular/src/api/resource/createResource.shipapi-smoke.spec.ts` was deleted after the
packed synthetic gate became required. The replacement path is:

1. unary success/error/cancellation assertions run through the exported shared runner;
2. dynamic `Function(import)` and server-internal imports are gone;
3. sibling-checkout detection and conditional skipping are gone;
4. the required packed command fails when any assertion/artifact is unavailable; and
5. `conformance/README.md` documents the offline local and strict external commands.

The completion signal is not “both repos are green.” It is “the exact artifacts a browser application installs have passed the shared contract, browser, SSR, package-boundary, and protocol matrix.”
