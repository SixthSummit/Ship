# ShipAngular stable release handoff

> Historical planning/evidence record. Status, versions, branches, and test counts
> below describe the original checkpoint, not the current release. Current release
> instructions are in `RELEASE_GUIDE.md`; package changelogs record shipped changes.

ShipAPI stable release `64ff1833e4fe58ce30b2865892bfe775d6658c1d` passed CI and
publication: [release workflow](https://github.com/SixthSummit/ship-api/actions/runs/34711190523).
The compatibility package is 4.0.0; the eight operation packages are 1.0.0.
ShipAngular remains 4.0.0-alpha.3 until its reviewed Version Packages PR lands.

## Acceptance evidence

A clean registry consumer passed source checks, types, tests, build and a real
PostgreSQL protected-read/transactional-write test. The published CLI generated
an application whose complete verification and compiled-server HTTP boot passed.
The joint fixture passed strict types, declared errors, validation, request IDs,
primitive forms, cookie-session refresh/replay, cancellation, real Chromium and
overlapping SSR against stable API packages and the published Angular alpha.
A wrong expected graph fingerprint was rejected.

`conformance/joint/stable-api-registry-receipt.json` records registry versions,
integrities and archive hashes. The retained joint artifacts were regenerated
using installed stable API packages, not framework source builds. Application
fixture code is a test input; generated contract/client/server packages are test
outputs. CI continues to exercise the current Angular candidate against them.
The API implementation and generated contract fingerprint did not change during
stable versioning. Ordinary third-party peers come from registry installs.

SAPI-48 and SAPI-51 record the complete receipt. Advanced generated non-JSON
bindings, backend streams/sockets and production-provider semantics retain their
existing explicit deferrals. This is not approval for production traffic.

## Merge and publication order

1. Merge the green SNG-31 stable-preparation PR into dev. This uses the supported
   Changesets prerelease exit; it does not hand-edit package versions. The release
   workflow verifies dev but skips versioning/publication when dev is outside
   active prerelease mode.
2. Establish main at that reviewed dev merge commit and apply the same strict
   GitHub Actions checks, PR requirement, administrator enforcement and no
   force-push/deletion protections as dev. Main does not exist at preparation
   time. Do not create it from an active-alpha commit.
3. Main's verified release workflow opens its Version Packages PR. Confirm the
   sole published framework becomes 4.0.0, version mirrors and template range are
   synchronized, prerelease metadata is removed, and all mandatory checks pass.
   Do not merge an old dev version PR as the stable release.
4. Merge the main Version Packages PR to publish through GitHub Packages. Confirm
   the actual registry archive, integrity and latest dist-tag; rerun isolated
   registry/joint acceptance with stable Angular before changing client pins.
5. Update migrated clients to exact stable package versions in their own PRs.
   Consumer deployment and rollout approvals remain separate.

No additional Changeset is required for this preparation: existing accumulated
Changesets produce 4.0.0. This PR changes release metadata, test evidence and repo
documentation, not published library behavior.

If preparation needs correction, fix it before the Version Packages merge.
Retain the existing alpha archives and client lockfiles; published versions are
immutable and any post-publication defect requires a new version.
