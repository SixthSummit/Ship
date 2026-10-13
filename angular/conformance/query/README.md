# Query conformance

This directory contains independent scenario assertions. It also contains a candidate bridge that delegates to the real public package APIs.

## Evidence levels

1. Run `vitest run --config conformance/query/vitest.config.mjs --coverage` to check the fixtures and the seeded defects. This is **fixture-only evidence**.
2. Compile `consumer.type-test.ts` against the assembled public entrypoint. Source-based compilation is preliminary evidence only.
3. Run `node conformance/query/run-archive.mjs <package.tgz> <candidate-bridge.mjs>` to check the physical package. The same archive supplies runtime code and types. The command runs types, node scenarios, real SSR stability checks, dedicated bridge coverage, and Chromium against that consumer. It fails if any gate fails. It does not skip missing packages. The first run can fetch exact dependencies with npm `--prefer-offline`. Set `SHIP_QUERY_OFFLINE=1` for a strict offline repeat after the npm cache is populated. A pnpm store alone is not an npm cache.
4. To repeat only the browser check, run `node conformance/query/run-browser.mjs <retained-consumer-directory>`. Run the browser scenarios in Chromium against that same installed archive. Run the SSR scenarios in separate Angular request injectors. These are required integration gates. Fixture success does not replace them.

The archive command retains its temporary consumer for inspection. It does not publish a package. The fixture server binds only to loopback. All credential strings are synthetic test data.

## Candidate bridge

The included `candidate.mjs` exports `createQueryAdapter`. The browser and server modules create real standalone OnPush Angular applications. The server module uses `platformServer` and separate Request objects. Import the public `@sixthsummit/ship-angular/query` and `/operations` entrypoints. Implement the port in `session-port.ts` by delegation to real package APIs. Do not add caching, retry loops, result conversion, identity masking, or optimistic state machines in the bridge.

Use these mappings:

| Port                     | Package behavior under test                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a browser session | A separate Angular injector with `provideShipQuery`; resolve its owned QueryClient and scope.                                                                                                                                                                                                                                    |
| Create a server session  | A separate request injector with `provideShipQueryServer`, `REQUEST`, and the operation boundary. Forward only the supplied session cookie through an explicit cookie-name allowlist. Sensitive authorization-header forwarding is forbidden by the operation boundary. Bind `requestSignal` to the Request.                     |
| `clientIdentity`         | The real native QueryClient object. Do not return a synthetic marker.                                                                                                                                                                                                                                                            |
| `read(input)`            | Use `shipQueryOptions` with `queryClient.fetchQuery`. Keep the normal finite freshness policy. For `force`, set `staleTime: 0` in those options. Pass caller signals through `call`. Once a component view exists, force refetch delegates to its real guarded `refetch`, so the scope scenario tests the actual helper outcome. |
| `view(input)`            | Read `injectShipQuery` signals from a real Angular component. Create and initialize the component before returning the view. Do not flush effects inside the view or `changeScope`. The immediate assertion must run before the next Angular tick.                                                                               |
| `invalidate(input)`      | Use `invalidateShipQueries` with the exact typed finite key and captured scope.                                                                                                                                                                                                                                                  |
| `page(input, cursor)`    | Use the native infinite observer/helper with `shipInfiniteQueryOptions`. Map the page parameter into operation input as `cursor`. Return native page envelopes and page parameters. Do not concatenate pages in the bridge.                                                                                                      |
| `changeScope`            | Delegate directly to `context.scope.change`.                                                                                                                                                                                                                                                                                     |
| `mutation(config)`       | Create one stable `shipMutationOptions` factory, and one `injectShipMutation` view. Map `execute` to `mutateAsync`; map `destroy` to the explicit factory owner teardown. Pass optimistic callbacks through unchanged.                                                                                                           |
| Session destruction      | Destroy the Angular injector and explicit mutation factory owners. Await cleanup where the port requires it.                                                                                                                                                                                                                     |

Declare `fixture.read` and `fixture.write` as structural unary operations. Use an explicit safe binding for reads. The binding input key must include all read input fields. Finite and infinite modes must use their actual distinct keys. The fixture client supplies normalized result values and exceptions; it does not provide a cache or operation policy.

For `policyRetry: 1`, use the real operation policy with safe reads, `retry: { maxAttempts: 2, statuses: [503] }`, and its deterministic delay hook. The fixture supplies two 503 responses for the exhaustion case. Do not retry transport exceptions. Query retry must stay disabled.

The fixture uses one retained validator across repeated 304 results. An uncached 304 must fail. Expected failures must preserve their public `OperationApiError` fields: status, code, declared flag, original error object, response metadata, details, and request ID. There is no `result` property on that error. The helper must not replace unexpected exceptions.

## Scenario inventory

The runner checks success, 204, repeated 304, missing 304 bodies, declared 422 failures, 409 conflicts, timeout identity, caller abort, deduplication, freshness, exact invalidation, finite/infinite isolation, page ordering, immediate identity masking, non-cooperative late transport results, mutation concurrency, rollback, owner destruction, late success callbacks, policy retry limits, request abort, and overlapping authenticated SSR users.

Each named scenario has one seeded defect in `reference-adapter.mjs`. The sensitivity test checks the specific assertion message. An unrelated fixture error is not sufficient. The reference implementation is a test oracle only. Never use it for candidate acceptance.

`runQueryConformance(factory)` executes every scenario. A caller can use `only` for debugging. A partial report lists every excluded scenario and reports `partial-scenarios`; it is not acceptance evidence.

`fixture-server.mjs` and `http-client.mjs` provide a separate real HTTP boundary. Server gates release requests explicitly. Tests cover cross-origin preflight, status and header preservation, abort, timeout, and overlapping authorization headers. The framework-neutral scenario files have no Node imports and can run in the packed browser app.

## M6 wiring notes

- Add the conformance command to the central package scripts and CI. This lane does not edit shared scripts or manifests.
- Assemble the public query exports before running the archive command. Compile the positive and negative type cases from that physical archive.
- Add the candidate bridge to the packed browser harness. Run the browser subset in a real Angular OnPush component; retain the before-tick checks. Run the server subset in real overlapping request injectors. Do not use a browser-mode provider to simulate SSR.
- Use the same artifact for node, browser, SSR, and types. Keep all resolution inside the temporary installed consumer. Do not add source aliases or sibling links.
- Add the assembled package to the existing packed/browser/joint and same-commit scaffold gates. Preserve root and operations-only checks without the optional TanStack peer.
- Retain the existing baseline resource and mutation tests. Their behavior is outside the reference fixture's authority.
- Record dependency versions, the archive path, scenario names, zero required skips, and browser/server results in the integration report.

The isolated author tests use Angular 20.3.30, TanStack Angular Query 5.104.1, TypeScript 5.8.3, RxJS 7.8.2, and tslib 2.8.1. The archive preparer pins these versions. Native helper PendingTasks tracking follows the accepted specification; the bridge must not add a second custom tracker.

## Candidate evidence and limits

The candidate suite imports only public installed entrypoints. It does not transform errors or reproduce caching, page concatenation, retries, or scope masking. SSR imperative QueryClient cancellation is accepted only through the upstream `isCancelledError` predicate; transport abort and operation PendingTasks are checked separately.

The bridge uses production Angular mode. Its browser fixture sets `gcTime: Infinity` and mutation `gcTime: 0` to avoid deferred native garbage-collection timers after observer detachment in the Node DOM harness. Real provider destruction still clears each owned cache. Default freshness and lifetime values have separate provider tests.

`packed-candidate.test.mjs` runs inside the physical consumer. `packed.vitest.config.mjs` requires at least 80 percent statements, branches, functions, and lines for each candidate module. This lane includes browser/server factories, session delegation, node dispatch, and SSR stability checks. Fixture coverage does not include these modules because their package imports must resolve from the physical consumer.

The final archive receipt reports the retained destination. The central integration gate also supplies the generated schematic consumer and the root/operations-only consumer without TanStack. These remain separate required proofs.

The packed candidate also runs through the real loopback HTTP fixture in Node and Chromium. This lane proves one wire request for overlapping reads, zero new wire requests for a fresh cache hit, an actual `If-None-Match` header with a 304 response, retained response bodies and validators, and server-observed cancellation. The exact server count is three requests. Chromium exercises real cross-origin preflight and exposed ETag headers. The browser runner resolves Vite and Playwright from the isolated consumer's pinned dependencies.
