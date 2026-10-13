# ShipAngular rearchitecture testing gates

> These gates implement the company testing standard for the rearchitecture. They are mandatory merge evidence, not aspirational coverage guidance.

## Current baseline and gaps

At the audited baseline:

- Vitest is configured with `jsdom` and recognizes both `*.test.ts` and legacy `*.spec.ts`.
- 244 core tests pass and six ShipAPI smoke tests skip when a sibling checkout is unavailable.
- coverage is 85.79% statements, 78.76% branches, 82.81% functions, and 87.47% lines;
- no coverage threshold is configured;
- the standard root `test` command does not collect coverage;
- modules copied into the release are outside the root workspace/test/Knip graph; and
- browser scaffold E2E is not a normal pull-request gate.

Phase 00 must close the global branch-coverage gap or formally isolate unreachable/generated exclusions with review. New architecture behavior cannot merge under a permanent “coverage will improve later” exception.

## Test conventions

- Framework: Vitest for unit and integration tests.
- Location: tests colocated with their source.
- Naming: new or substantively rewritten tests use `FileName.test.ts`.
- Legacy migration: existing `*.spec.ts` remains supported until a separate mechanical rename. Do not mix mass renaming with behavior changes.
- Scope: each test verifies one named behavior and includes error/edge paths appropriate to the code.
- Determinism: fake clocks, deterministic IDs, local fixture servers, and controlled browser contexts replace sleeps/live services.
- Isolation: clean up injectors, global fakes, sockets, streams, XHR, timers, and DOM state after every test.
- External dependencies: use explicit fakes or the versioned local conformance fixture; never call production or provider systems.
- AI-assisted tests: expected and welcome, but an engineer reviews assertions, failure sensitivity, edge cases, and whether the test would catch the intended regression.

## Coverage policy

The minimum is 80% for statements, branches, functions, and lines—not an average that hides a weak category.

Every code-changing PR must satisfy both:

1. **Changed-file gate:** each materially changed source file is at least 80% in all applicable metrics, or has a documented reviewed exclusion for generated/type-only/unreachable platform code.
2. **Global gate:** repository coverage remains at or above 80% in all metrics and does not regress below the ratcheted baseline.

Once a global metric exceeds 80%, record and ratchet its threshold periodically rather than allowing it to drift back to 80%. Critical request-policy, auth, SSR isolation, result parsing, and state-machine code requires behavior-complete tests even when line coverage is already high.

Coverage exclusions are limited to configuration, type-only declarations, barrel exports, generated code, version constants, and test setup. An exclusion cannot hide implementation logic merely because it is difficult to test.

## Gate stack

### G0 — Change hygiene

Required for every PR:

- Conventional Commit history or squash title is valid.
- PR identifies phase/checkpoint, risk, rollback, and public compatibility.
- Tests are included with feature/fix behavior.
- No unrelated formatting, lockfile, generated output, or dependency churn.
- Consumer-visible changes include an accurate Changeset.
- New/changed docs and examples match actual public symbols.

### G1 — Static correctness

- strict TypeScript projects pass with no emitted output;
- Angular template/compiler diagnostics pass;
- ESLint/Biome responsibilities pass without blanket disables;
- formatting check passes on tracked project files;
- Knip/dependency checks cover every shipped project;
- public declaration/type tests pass; and
- forbidden imports and browser-global SSR usage are rejected.

No `any`, double cast, non-null assertion, or lint suppression is accepted at a public/contract boundary without a localized explanation and negative test.

### G2 — Unit and integration behavior

- all Vitest suites pass;
- required skipped tests equal zero;
- changed-file and global coverage gates pass;
- public methods, errors, edge cases, cancellation, cleanup, and races are covered;
- fake-clock retry/timeout tests make no wall-clock sleeps; and
- mutation tests assert exact attempt count and body identity.

A documented provider/platform test may skip only when the suite is non-required and the reason/owner/removal condition appears in the test and PR. Required contract, browser, SSR, and package tests may not skip based on local availability.

### G3 — Contract and type conformance

- ShipAPI fixture graph generates deterministic bytes and graph hash;
- ShipAngular installs exact packed contract/client tarballs;
- positive type consumers compile;
- wrong operation ID/input location/input type/status/error assumptions fail compilation;
- valid application failures retain code/status/details/metadata;
- malformed protocol and transport failures remain distinct; and
- no source/workspace link can satisfy the test accidentally.

This gate is required for changes to operation types, results, errors, codecs, providers, policies, resources, or compatibility adapters.

### G4 — Browser and SSR conformance

- Playwright runs against a deterministic local fixture server;
- CORS-exposed metadata, cookies, XHR progress, downloads, streams, and WebSockets use a real browser where applicable;
- SSR creates a fresh request injector/context;
- overlapping user A/B renders prove cookie/token/ID/locale/cache/abort isolation;
- browser globals are not accessed during server rendering;
- caller/destroy/supersession/SSR cancellation reaches actual I/O; and
- logs and snapshots contain no tokens, cookies, CSRF values, raw provider errors, or unredacted sensitive values.

This gate is scoped to affected capabilities during development and runs as a full matrix before each prerelease/release checkpoint.

`pnpm test:browser-conformance` is the required local ShipAngular transport subset. It packs
the current build into a clean temporary consumer and drives cross-origin upload, download,
SSE, and WebSocket scenarios in Chromium against `conformance/browser/fixture-server.mjs`.
The real ShipAPI artifact and concurrent Angular SSR portions remain part of the joint gate.

### G5 — Package and clean-consumer proof

- ShipAngular, contract, and client packages are built and packed;
- fresh browser and SSR consumers install only tarballs/registry artifacts with a frozen lockfile;
- browser bundles contain no Hono route tree, Drizzle, database, Firebase Admin, server observability SDK, Node builtin, or workspace/source link;
- every public secondary entrypoint imports and tree-shakes independently;
- package contents include required schematics/rules/assets and no accidental sources/secrets;
- per-entrypoint and fixture-app bundle budgets pass; and
- generated documentation/examples compile against the packed public API.

### G6 — Client migration and release

- the target site has a recorded source version and dependency inventory;
- automated migration/diff completes with reviewed manual exceptions;
- site-specific unit/integration/Playwright tests pass;
- staging smoke covers auth, navigation, primary reads/mutations, errors, and used transport capabilities;
- production deployment is observable and has an explicit rollback owner/window;
- pin/lock/artifact rollback has been exercised or verified; and
- post-deploy evidence is linked in the site inventory.

Compatibility code cannot be removed until every in-scope site passes G6 or has an approved owner/date disposition.

## Phase gate mapping

| Phase | Minimum gates on every PR | Full exit gates                                       |
| ----- | ------------------------- | ----------------------------------------------------- |
| 00    | G0, G1, G2                | baseline report and G0–G2 policy approval             |
| 01    | G0–G3, G5 artifact subset | G1–G3 and packed forbidden-import proof               |
| 02    | G0–G3; G4 for SSR/policy  | G1–G5 unary subset                                    |
| 03    | G0–G4                     | G1–G5 vertical slice and compatibility parity         |
| 04    | G0–G4                     | full auth/SSR G1–G5                                   |
| 05    | G0–G4                     | full browser transport G1–G5                          |
| 06    | G0–G3, G5                 | full G1–G5 package/form/module surface                |
| 07    | G0–G5                     | complete automated G0–G5 on supported Node matrix     |
| 08    | G0–G6                     | all sites dispositioned; release candidate full G0–G6 |

## Required test review questions

Reviewers answer these for architecture PRs:

1. What incorrect implementation would make this test fail?
2. Does the test assert behavior, or merely reproduce the implementation?
3. Are success, declared failure, exceptional failure, cancellation, and cleanup distinguished?
4. Could concurrency, stale completion, reconnect, refresh, or retry execute the action twice?
5. Does the test exercise the packed/public boundary rather than a private shortcut?
6. Are sensitive values redacted from failures and snapshots?
7. Does the test remain deterministic offline?

## Checkpoint evidence format

Every phase exit adds or links a short checkpoint report containing:

```text
Checkpoint:
Commit / PR:
Artifact manifest and graph hash:
Commands and CI runs:
Tests passed / failed / skipped:
Coverage (statements / branches / functions / lines):
Bundle and tarball measurements:
Known limitations with owner/date:
Rollback evidence:
Approvers:
```

Screenshots or “works on my machine” are supplemental, not substitutes for commands, artifacts, and assertions.
