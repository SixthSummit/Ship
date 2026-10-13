# Query release handoff draft

This record prepares SNG-59. It does not complete that ticket.
The feature passes the checks recorded below. The required security gate fails.
SNG-60
blocks final SNG-57 and SNG-59 acceptance. Do not merge or publish from this record.

The source base is `1846e2ab7f722559e408441912d654553e34b03c`.
The tested candidate was built from a changed working tree.
The verified feature source is now committed as `0e938107b0a94dea8549bb78860263568d094f99`.
The archive and local check receipts retain their pre-commit origin.
The same-commit GitHub CI link remains pending.
No successful GitHub CI run is claimed here.

## Compatibility

| Item                     | Tested candidate | Requirement                                                                                       |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| ShipAngular archive      | 4.1.0            | Local candidate. No registry release is claimed.                                                  |
| Angular                  | 20.3.30          | Tested exact version. Baseline security remediation needs newer patches and another complete run. |
| TanStack Angular adapter | 5.104.1          | Experimental. Install and pin this exact version.                                                 |
| TypeScript               | 5.8.3            | Strict public and generated consumer checks pass.                                                 |
| Local Node               | 26.8.1           | Required GitHub Node 20 and 22 jobs remain unverified here.                                       |
| pnpm                     | 10.8.1           | Use the frozen repository lockfile.                                                               |

The optional `@sixthsummit/ship-angular/query` entrypoint owns Query integration.
The root and `/operations` helpers remain available without TanStack.
A physical root and operation-only consumer passes with the optional peer absent.
The adapter uses the native TanStack engine. It adds no second cache.
The `operation-query` generator requires explicit safe-operation configuration.
It does not install dependencies by default.

Read the [Query guide](../../guides/TANSTACK_QUERY.md) and
[release guide](../../../RELEASE_GUIDE.md) before adoption.
Use guarded signal helpers for views. Low-level option builders require a scope guard.
Inputs must remain immutable until their request settles.
Use explicit scoped cache effects for optimistic edits and invalidation.
Take-latest mutation execution is incompatible with an optimistic policy.

V1 has no persistence or SSR cache transfer. Each SSR request owns a client and scope.
Browser reads can repeat server reads. Infinite reads do not use ETags.
Realtime connections, replay, reconnect, and dropped-event handling belong to the application.
Sequence hints are not a durable replay cursor.
`trackPendingTasks: false` disables operation-boundary tracking only.
Native finite and infinite Angular Query helpers still use upstream PendingTasks tracking.
The Ship mutation helper uses a native MutationObserver and adds no separate tracker.

## Declaration correction

The build now uses the existing strict library compiler configuration.
The published concrete Firebase and mock adapter bearer-token methods now return
`Promise<string | null>`. The prior concrete declaration said `Promise<string>`.
The nullable capability interface and signed-out runtime behavior already allowed `null`.
Runtime behavior is unchanged. Concrete consumers can get a new compiler error.
Add a null check before using a token:

```ts
const token = await adapter.capabilities.bearerToken.getToken();
if (token === null) {
  return;
}
useToken(token);
```

Independent comparison against the exact base build found no other semantic change
in the existing public declarations. The minor Changeset records this correction.
Review this compatibility risk in the PR and release notes. Do not describe all
existing concrete declarations as unchanged.

## Evidence

[feature-validation.json](feature-validation.json) stores exact versions, archive integrity,
assertion groups, results, and pending final fields.
[audit-baseline.json](audit-baseline.json) stores both advisory inventories, counts,
raw-response hashes, affected paths, patched-version ranges, and upstream links.
These records retain portable results. Temporary paths are diagnostic references only.

Independent feature checks include:

- Main framework: 1,056 tests in 77 files, with zero required skips.
- Generator: 50 tests and 100% coverage in all metrics. The physical generated wrapper also compiles.
- Controlled example: seven tests, with 99.09% statements, 93.75% branches, 97.29% functions, and 100% lines.
- Physical archive: ten Node scenarios, nine Chromium scenarios, and six real SSR stability checks.
- Candidate bridge: three tests, with 98.92% statements, 95.58% branches, 93.47% functions, and 100% lines. Each file exceeds 80% in every metric.
- HTTP Query: two concurrent owners make one server request. A fresh hit adds none. Request two sends the retained validator and keeps the body on 304. Caller cancellation reaches the server on request three.
- Fixture oracle: 19 tests; types, ESLint, Biome, and README formatting pass.
- All entrypoint builds and existing public declaration review pass.

Physical consumer imports resolve from the installed archive. They use no source aliases
or framework source links. The real browser and request providers are exercised.
The candidate delegates caching, retries, paging, and scope projection to actual public APIs.

The tested archive SHA-256 is
`273ae8b5d413647b5b765d4c52ed95a40620d8e8559c64f8f391618c0b475d60`.
Its SHA-512 installation integrity is in the JSON record.
This is the pre-commit archive. A final frozen build can produce a different archive.
Update integrity and rerun consumers after any package change.

To reproduce from this candidate, use the archive file with that SHA-256:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:query-example
pnpm test:query-conformance
pnpm test:packed-conformance
pnpm run audit
```

The integrated Query gate builds or consumes the physical archive and runs public types,
generated consumers, Node, Chromium, SSR, and HTTP checks.
It is not a substitute for the complete required CI workflow.
Install an inspected local archive in an isolated consumer with:

```sh
pnpm add --save-exact /absolute/path/to/verified-ship-angular.tgz
pnpm add --save-exact @tanstack/angular-query-experimental@5.104.1
```

For a registry upgrade, first obtain the exact published version and integrity from the
release job and GitHub Packages. Replace the local path with that exact version.
Do not use the moving `alpha` tag for reproducible acceptance.
Do not infer that the candidate version is available from a registry.

SNG-58 has an independent physical consumer measurement receipt in the JSON record.
It uses this same archive and compiles the actual example workflows against public exports.
Four tests pass. Coverage is 93.61% statements, 92.3% branches, 96.87% functions, and
94.38% lines. Each runtime fixture file exceeds 80% in every metric.
Two baseline owners make two detail requests. Query owners share one.
Returning to fresh detail 1 adds one baseline read and no Query read.
A successful edit adds one shared detail refresh and two Query list reads: the finite
list and the initial infinite page. The baseline owner reloads one list.
The unrelated active detail observer keeps its request ID. An isolated seeded overbroad
invalidation fails that assertion. The test therefore detects an unwanted refetch.
Rollback, paging, tenant replacement, logout, and non-cooperative late reads also pass.
The controlled delay establishes ordering. No latency gain is claimed.
The adapter bundle excludes the optional peer's own cost.
Final same-commit acceptance and security remediation remain required.

## Required security result

`pnpm audit --audit-level=high` fails on both unchanged dev and the candidate.
Both report 24 advisory records: 14 high, eight moderate, and two low.
The advisory ID sets match. Query introduces no advisory ID.
That comparison does not make the baseline advisories acceptable.
The required gate remains active. No exception or suppression was added.

Angular platform-server requires at least 20.3.31. Angular router requires at least
20.3.32. Align the Angular patch suite and repeat validation after remediation.
Other patch and parent-package updates require the SNG-60 compatibility review.

The http-cache-semantics advisory reports no patch through 4.2.0.
Registry 4.3.0 exists outside its affected range. It is a candidate update,
not a verified maintainer security fix.
The braces registry latest 3.0.3 has no available patched release.
Removing the Changesets 2 dependency path requires a separately reviewed migration.
See the compact audit record and upstream links for exact findings.

## Rollback

Before adoption, record the application's exact prior package version, lockfile,
provider configuration, and verified prior artifact integrity.
Retain the prior artifact if it is local. Check registry access if it is published.
Do not assume a previous package version is still available.

1. Stop application-owned Query event listeners and dispose the Query feature owner.
2. Restore the prior application code. Remove Query providers, `/query` imports,
   generated Query wrappers, and Query cache-effect calls. Restore the existing operation helpers.
3. Restore the prior exact framework version and reviewed lockfile. For a retained
   artifact, install its verified local path. For a verified registry version, install
   that exact version with `--save-exact`.
4. Remove the optional TanStack dependency only when no other application feature needs it.
5. Run the prior application's build, types, tests, and session/logout checks.
6. Confirm that SSR request ownership and realtime listener cleanup still match the prior code.

No Query cache persistence or transfer state needs migration.
A cache reset cannot undo a server write. Reconcile completed writes with the server
before retrying an edit during rollback.

## Publication handoff

A merge into `dev` can trigger automatic alpha publication after required CI succeeds
for that exact commit. Release uses pending Changesets and publishes an alpha snapshot.
No manual publication is needed. No `.changeset/pre.json` is added.
This handoff does not authorize merge, publication, deployment, or site migration.

Before closing SNG-59, the release owner must record:

- The verified feature commit, clean source state, and passing same-commit GitHub CI URL.
- Passing required security verification after SNG-60 remediation.
- The final archive hash, integrity, exact computed release version, and physical consumer receipts.
- Reconfirmed SNG-58 packed example measurements for the final archive and the measured optional peer cost.
- PR and release-note treatment of the concrete nullable token correction.
- Explicit owners for remaining required work and a verified rollback artifact/version.

SNG-57 and SNG-59 remain open until these requirements pass.
