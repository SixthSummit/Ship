# Optional Query package integration verification

This record covers SNG-56 source composition before a feature commit.
The base source commit is `1846e2ab7f722559e408441912d654553e34b03c`.
The tested working tree contains the Query changes, now recorded in feature commit
`0e938107b0a94dea8549bb78860263568d094f99`. These local and archive receipts retain their pre-commit origin.
They are not clean-commit CI receipts.

## Exact versions

- ShipAngular package: 4.1.0, with a consumer-visible Changeset.
- Angular: 20.3.30.
- Experimental TanStack Angular adapter: 5.104.1.
- TypeScript: 5.8.3.
- Vitest: 4.1.11.
- Vite for the isolated browser consumer: 7.3.6.
- Playwright: 1.63.0.
- Local verification runtime: Node 26.8.1.

The Query adapter is an exact optional peer and an exact repository development dependency.
Root and operation-only consumers can omit it.
The CI matrix remains Node 20 and Node 22. A clean-commit CI result is still required.

## Composition

The physical `/query` entrypoint contains the real key, read executor, finite and infinite
query, browser and request provider, scope, mutation, and explicit cache-effect modules.
It exports the public binding, provider, scope, options, signal helper, and cache APIs.
It does not export observer scope wrappers or provider registration markers.
Scope modules use the canonical key snapshot type.
Cross-entrypoint references use the public `/operations` boundary.
Track-only compiler and Vitest harness files are absent from runtime source.
The packed generator excludes its tests, declaration fixture, and integration notes.

The build explicitly uses the existing strict library compiler configuration with
ES2022, DOM, and DOM.Iterable. Independent comparison found two corrected concrete
bearer-token declarations: Firebase and mock adapters now return `Promise<string | null>`.
Their runtime behavior and the existing nullable capability interface remain unchanged.
Concrete consumers must check null. No other existing public declaration changed
semantically. See the Changeset and bundle budget review.

## Feature verification

The following local checks passed:

- Workspace type checks, including source and negative Query type programs.
- Framework and docs builds through Turbo.
- Root ESLint, import ordering, formatting, eval validation, and Knip.
- Main framework coverage: 1,056 tests in 77 files; 95.15% statements, 89.26% branches,
  96.86% functions, and 96.76% lines.
- Required generator Node coverage: 50 tests; 100% in all metrics.
- Guide example: seven tests; 99.09% statements, 93.75% branches, 97.29% functions,
  and 100% lines.
- Existing packed, Chromium transport, and real ShipAPI joint conformance.
- CLI scaffold creation without installation.
- Selective per-entrypoint bundle enforcement.

The physical Query gate uses one archive for generated-consumer checks, strict public
signatures, Node and browser scenarios, request stability, and HTTP verification.
The archive SHA-256 is `273ae8b5d413647b5b765d4c52ed95a40620d8e8559c64f8f391618c0b475d60`.
The gate records its actual archive hash, source commit, dirty-tree state, and versions
on every run. The installed package is not a source link, and Vite has no source aliases.
Browser tooling resolves from the isolated installed consumer.

The generated wrapper and the guide's real fixture/workflow compile against the physical
package. Positive checks include selected-data inference. Negative checks cover wrong
operation inputs, caller retry replacement, and an invalid operation ID.
The existing packed root/operations consumer installs and compiles without TanStack;
its receipt includes `optionalQueryPeerAbsent: true`.

The native adapter passes ten Node scenarios, nine Chromium scenarios, and six real SSR
PendingTasks cases. The dedicated physical candidate has three tests with 98.92%
statements, 95.58% branches, 93.47% functions, and 100% lines; each file must reach 80%.
Actual Node and Chromium HTTP calls prove one-request deduplication, fresh-cache reuse,
If-None-Match/304 body retention, and transport cancellation observed by the server.

`pnpm test:query-conformance` runs the oracle fixture checks, packed generation, public
package types, actual native scenarios, SSR stability, per-file candidate coverage,
Chromium, and the four packed controlled-workflow tests. CI invokes this gate after
downloading the exact core build. The workflow coverage is 93.61% statements, 92.3%
branches, 96.87% functions, and 94.38% lines, with per-file 80% thresholds. Two baseline
detail owners make two requests; two Query owners share one. Returning to fresh detail
adds one baseline request and no Query request. Save refreshes one shared detail plus
finite and infinite lists, while an unrelated active detail keeps its request ID. These
fixture counts are not a production latency or customer migration claim.
`pnpm test:query-example` is a separate required example coverage gate.
Framework coverage also requires the dedicated generator coverage lane.

A pre-existing download fixture failed on unchanged dev because jsdom Blob lacks `text()`.
The test now reads the same bytes through FileReader when needed. Production behavior
was not changed. Independent review accepted this verification prerequisite.

## Security and release status

The required `pnpm audit --audit-level=high` gate still fails.
Unchanged dev and this candidate report the same 24 advisory records: 14 high, eight
moderate, and two low. The Query change introduces no advisory ID.
No audit exception, ignore, major upgrade, or gate relaxation was added.

The [http-cache-semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
reports no patched release for its affected range through 4.2.0. Registry version 4.3.0
exists outside that range. It is a candidate compatible update, not a verified maintainer
security fix. SNG-60 must test it and rerun audit. The
[maintainer issue](https://github.com/kornelski/http-cache-semantics/issues/56) was closed
as not planned; that does not establish that 4.3.0 fixes the issue.

The latest `braces` release, 3.0.3, has no available patched release for
GHSA-vfj7-8cjw-p6xm. Removing its Changesets 2 dependency path needs separate migration
review. Angular platform-server and router also require newer patch releases than the
initial 20.3.30 verification candidate. Other baseline advisories are recorded in the
audit output.

SNG-60: Restore the required security audit gate
tracks baseline remediation. SNG-57 and the SNG-59 release checklist remain open.
This evidence supports feature review. It does not establish passing full CI, merge
readiness, publication approval, or release completion.
