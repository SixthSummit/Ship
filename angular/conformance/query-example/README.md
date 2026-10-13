# Controlled Query example

This example is a typed feature factory, ready for a standalone application host.
It is not a deployed demonstration application.
Both modes use the same local list, detail, and edit contract.
They use no service, URL, credentials, or production data.

Create `createExampleFixture()` once in the application feature injector.
Choose `createBaselineWorkflow(fixture)` or `createQueryWorkflow(fixture, context)` inside that injector.
Bind the returned signals to a standalone OnPush component.
For Query mode, obtain `context` through `inject(SHIP_QUERY_CONTEXT)`.
Use `browserQueryProviders` in the application injector.

## Compare the same workflow

1. Set `fixture.delayMs` to 150 milliseconds.
2. Create two owners in the selected mode.
3. Wait until each detail displays `First`.
4. Read `fixture.counters().detail`.
5. In Query mode, prefetch ID 2, then set `selectedId` to 2.
6. Save `{ id: 1, title: 'Saved' }`.
7. Set `fixture.rejectNextEdit` to true, then save another title.
8. In Query mode, call `logout()` while work is pending.

Pass conditions:

- Two baseline owners make two detail requests.
- Two Query owners make one detail request for the same fresh key.
- Prefetch makes one request for ID 2. Selection reuses its fresh envelope.
- Baseline save explicitly reloads its owner's reads. The other owner remains unchanged.
- Query success invalidates explicit list, detail, and infinite targets.
- A rejected Query edit restores the prior detail envelope after its optimistic update.
- Logout hides old data immediately, before the Angular effect flush.
- Infinite pages retain `[null, 2]` page parameters and report the end after page 2.
- Concurrent next-page triggers make one request.

The delay and counters are Angular signals. Reset the fixture to reset server data and counters.
Inputs remain immutable until each request settles.
The fixture's generic result cast bridges only its controlled runtime dispatch.
It does not cast an untyped application client into a generated contract.

## Factory and listener lifetimes

The feature owner constructs each mutation factory once and destroys it when the feature ends.
A child view that shares the factory only detaches its observer when destroyed.
The returned workflow uses guarded read and mutation helpers.
It does not expose an unguarded native observer.

`connectExampleEvents` accepts an application-owned event adapter.
Change, reconnect, and dropped-event callbacks invalidate captured-scope list/detail targets.
The scope cleanup and returned disposer remove the listener.
The application's realtime transport owns connection, sequence detection, and resubscription.
No socket library enters the Query package.

`requestQueryProviders(scopeKey)` creates provider definitions for each SSR request injector.
Provide the request-owned operation client in that same injector.
No cache is transferred into the browser. Browser reads can repeat SSR reads.

## Local verification

Candidate: Angular 20.3.30, TanStack Angular Query 5.104.1, TypeScript 5.8.3, Vitest 4.1.11.
Run from the repository root:

```sh
node_modules/.bin/tsc -p conformance/query-example/tsconfig.json
node_modules/.bin/vitest run --config conformance/query-example/vitest.config.ts --coverage
node_modules/.bin/biome check conformance/query-example
```

The local facade resolves public names to actual implementation declarations.
The local Vitest harness uses the exact candidate dependency installed for adapter verification.
It is a temporary integration aid, not the packed package proof.
Seven runtime tests pass. Coverage is 99.09% statements, 93.75% branches, 97.29% functions, and 100% lines.
Each materially changed runtime fixture module exceeds 80% in all metrics.
The tests assert shared requests, prefetch reuse, pagination, rollback, identity masking, baseline reload, cancellation, and realtime cleanup.
This is source-composition evidence. It does not establish release acceptance or packed-package behavior.

M6 integration tasks:

- Replace the local facade alias with the physical `/query` public entrypoint.
- Replace the isolated dependency path in the local Vitest configuration with the integrated dependency.
- Add the fixture to maintained type and test programs. Remove redundant temporary harness configuration.
- Add `docs/guides/TANSTACK_QUERY.md` to canonical docs navigation and copy configuration.
- Regenerate docs mirrors through the normal copy script.

M7 consumer tasks:

- Compile this workflow against the packed package exports.
- Run the same controlled assertions with the packed browser-safe contract fixture.
- Confirm application teardown, SSR request separation, and the documented dependency versions.
