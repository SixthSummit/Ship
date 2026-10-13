# Ship release guide

Ship uses one root Changesets directory and independent package versions. Package names, entrypoints, and existing changelogs are retained. `fixed` and `linked` groups are empty.

## Preparation

Work on `dev`. Add root `.changeset/*.md` entries for affected published packages using `pnpm changeset`. API and Angular share a repository, not a version number or runtime dependency graph. Angular consumes the browser-safe contract package only.

Before promotion run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm run ci`, `pnpm test:pack`, and `pnpm audit:runtime`. CI additionally checks API integration/parity, edge, consumer packaging, documentation, and Angular browser/joint conformance.

## Publishing is initially disabled

The release workflow is manual (`workflow_dispatch`) and requires `SHIP_PUBLISH_ENABLED=true`. It refuses branches other than `dev` and `main`. No import, push, or PR automatically publishes packages.

The registry remains GitHub Packages (`https://npm.pkg.github.com`), matching existing packages. Open-source visibility does not itself migrate packages to npmjs.org. Before enabling publishing, verify package ownership, grant this repository Actions access to the existing packages, and confirm consumers can authenticate/download as intended. No credentials are copied from the former repositories.

## Alpha from dev

Dispatch the release workflow on `dev`. It verifies the checkout, runs `changeset version --snapshot alpha`, synchronizes Angular version mirrors, builds all packages, and publishes with the `alpha` dist-tag. Snapshot version changes are not committed. Changesets pre mode is not used.

## Stable from main

When ready, promote reviewed `dev` work to `main`. Run `pnpm version-packages` on a release branch and review the generated package versions/changelogs and lockfile in a PR targeting `main`. Merge that PR, then dispatch the release workflow on `main`. Stable dispatch requires no pending changesets and publishes the versioned packages under `latest`. The workflow does not open or merge version PRs automatically.

Configure protections for `dev` and `main`, requiring successful CI and review before release use. Run only one release at a time. Git history before the monorepo import remains in the original private repositories.
