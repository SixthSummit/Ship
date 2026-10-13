# Bundle budget review — 2026-09-08

This revision updates only the `/auth`, `/download`, and `/socket` runtime entries in
`.bundle-baseline.json` after the architecture-review fixes. The 5% per-entrypoint and
aggregate gzip limits are unchanged. All other runtime and declaration baselines remain
unchanged; totals are recalculated from the selectively updated entries.

These measurements describe complete published FESM and declaration files, not a tree-shaken
application bundle. They were measured from a fresh Node 22.22.0 core build using
`pnpm measure-bundle --json` and the existing gzip/Brotli measurement implementation.

| Artifact                 | Previous raw bytes | Current raw bytes | Previous gzip bytes | Current gzip bytes |   Gzip change | Previous Brotli bytes | Current Brotli bytes |
| ------------------------ | -----------------: | ----------------: | ------------------: | -----------------: | ------------: | --------------------: | -------------------: |
| `/auth` runtime          |              9,027 |            10,992 |               2,105 |              2,341 | +236 (+11.2%) |                 1,811 |                1,997 |
| `/download` runtime      |              9,012 |            12,187 |               2,401 |              3,064 | +663 (+27.6%) |                 2,049 |                2,645 |
| `/socket` runtime        |             18,463 |            19,726 |               3,725 |              4,024 |  +299 (+8.0%) |                 3,240 |                3,511 |
| `/auth` declarations     |              2,916 |             2,987 |                 939 |                953 |   +14 (+1.5%) |                   772 |                  785 |
| `/download` declarations |              3,883 |             3,883 |               1,065 |              1,065 |             0 |                   912 |                  912 |
| `/socket` declarations   |              4,948 |             5,014 |               1,249 |              1,303 |   +54 (+4.3%) |                 1,077 |                1,116 |

The three runtime baselines grow by 1,198 gzip bytes in total. The measured complete artifact
set is 109,169 gzip bytes, compared with the previous aggregate baseline of 107,367 bytes
(+1.68%). The selective new baseline totals 108,565 gzip bytes; other changes must still fit
their existing per-entrypoint budgets.

## Why the additional code is retained

- `/auth` separates credential-policy refresh from superseding user actions, composes caller
  cancellation, and tracks in-flight refresh controllers so sign-out/destroy abort them. This
  prevents initialization from aborting itself without allowing stale refresh work to survive
  sign-out. No runtime dependency was added.
- `/download` refuses credential-bearing redirects and owns the returned stream until EOF,
  error, timeout, or cancellation. The wrapper retains the reader and call scope, propagates
  cancellation in both directions, and suppresses stale completion. Returning the raw stream
  would remove the extra code but restore the reviewed lifecycle defect. No runtime dependency
  was added.
- `/socket` composes ticket cancellation, validates browser-sendable close codes and reason
  length, and blocks sends/messages after protocol failure. The application close code is
  `4002`; using reserved `1002` fails in real browsers. No runtime dependency was added.

## Optimization and verification

Before rebasing, the auth runtime measured 2,364 gzip bytes and its declarations 999 bytes.
Removing a redundant generation check (tracked controller cancellation already rejects every
superseded refresh) and keeping an internal explanation out of emitted declaration JSDoc
reduced these to 2,341 and 953 bytes. Concise public socket JSDoc retained its valid code range
and default while reducing its declarations from 1,314 to 1,303 gzip bytes. Declaration
baselines therefore did not need revision.

The focused auth suite passed all 20 tests after the simplification, including refresh/replay
and sign-out/destroy cancellation. The fresh core build passed. The preceding full uncached
suite passed 564 tests and the packed Chromium gate proved redirect blocking, native Blob
contents, and both protocol-error close frames. Final aggregate gates run against these exact
artifacts and the selective baseline; baseline revision does not substitute for those gates.

## Firebase auth session races — 2026-09-15

This revision selectively updates only the `/firebase-auth` runtime and declaration
entries after the session-race fix in `e75453f`. The 5% per-entrypoint and aggregate
gzip limits in `scripts/measure-bundle.js` remain unchanged. Every other entry keeps
its prior baseline; totals are the sum of the selectively updated entries.

Measurements come from the exact reviewed implementation, rebuilt against the rebased
`dev` branch with Node 22.22.0 using `pnpm --filter @sixthsummit/ship-angular build`
and `pnpm measure-bundle --json`. They describe published FESM/declaration artifacts,
not a tree-shaken consumer application.

| Artifact                      | Previous raw bytes | Current raw bytes | Previous gzip bytes | Current gzip bytes |   Gzip change | Previous Brotli bytes | Current Brotli bytes |
| ----------------------------- | -----------------: | ----------------: | ------------------: | -----------------: | ------------: | --------------------: | -------------------: |
| `/firebase-auth` runtime      |              6,219 |             7,252 |               1,679 |              1,970 | +291 (+17.3%) |                 1,463 |                1,717 |
| `/firebase-auth` declarations |              1,758 |             1,861 |                 630 |                663 |   +33 (+5.2%) |                   513 |                  536 |

The runtime increase pays for identity checks and separate state/session counters:
late token success or failure cannot replace a newer account or revive a signed-out
session; token-before-auth callbacks cannot strand initialization; bearer reads cannot
return credentials from an ended session. The declarations include the additional
private bookkeeping. Public capability and auth-state shapes are unchanged, and no
runtime dependency was added. The shared event path already removes the duplicated
auth/token handlers; all remaining race guards are retained.

These two entries add 324 gzip bytes to the approved baseline, changing its totals
from 416,301 raw / 108,565 gzip / 92,998 Brotli bytes to 417,437 raw / 108,889 gzip /
93,275 Brotli bytes (+0.30% gzip). The entire current artifact set measures 420,870 raw /
109,461 gzip / 93,795 Brotli bytes. Unrelated differences are deliberately not adopted:
they remain subject to their existing per-entrypoint limits.

The fix already passed independent adapter/conformance review, 579 framework tests,
coverage, type-check, lint, packed and browser conformance.

## ShipAPI client boundary — 2026-09-24

This revision updates only the `/ship-api` runtime baseline for SAPI-429. A fresh
Node 22.22.0 build measures 12,037 raw / 3,083 gzip / 2,615 Brotli bytes, compared
with 10,869 raw / 2,784 gzip / 2,360 Brotli bytes previously. The 299-byte gzip
increase (+10.7%) exceeds the unchanged 5% per-entrypoint budget, so it is reviewed
here rather than changing the threshold. The selective baseline totals become
490,444 raw / 127,633 gzip / 109,396 Brotli bytes, an increase of 0.23% gzip.
All other entries retain their prior baselines.

The added runtime guards reject HTTP stream declarations before constructing a unary
client and reject synchronous handles returned where a unary Promise is required.
The adapter also recognizes ShipAPI's `IDEMPOTENT_IN_FLIGHT` framework error. These
checks preserve the boundary between unary and stream operations when a generated
client or manifest is supplied at runtime. The canonical ShipAPI client type is an
erased TypeScript import, so it adds no ShipAPI code to the published runtime bundle.

The focused adapter tests cover stream rejection, non-Promise returns, and the
409 classification. The fresh build and `pnpm measure-bundle:enforce` validate the
selective baseline; the PR's remaining CI gates validate the full package.

## Optional TanStack Query entrypoint — 2026-10-08

The new `/query` entrypoint has an initial measured budget of 62,167 raw / 12,846 gzip /
10,598 Brotli runtime bytes and 19,633 raw / 4,745 gzip / 4,065 Brotli declaration bytes.
TanStack remains an external optional peer. These numbers describe ShipAngular's
adapter artifacts; they do not include TanStack's application bundle cost.

The strict ES2022 package build also restores `Promise<string | null>` for the concrete
Firebase and mock adapter bearer-token capabilities. Independent comparison against
source commit `1846e2ab7f722559e408441912d654553e34b03c` found no other semantic change in
existing entrypoint declarations. The existing auth capability interface already permits
null, and signed-out runtime behavior is unchanged. Concrete adapter consumers may
need a null check. The Changeset and Query guide describe that migration.

Only the `/firebase-auth` declaration baseline is refreshed for that correction:
1,904 raw / 697 gzip / 565 Brotli bytes. The 34-byte gzip increase exceeds the unchanged
5% per-entrypoint limit. Root and operation runtime artifacts remain unchanged.
All other existing measurements retain their approved budgets. The selective baseline
now totals 572,287 raw / 145,258 gzip / 124,088 Brotli bytes. A fresh package build and
`pnpm measure-bundle:enforce` pass against these budgets.
