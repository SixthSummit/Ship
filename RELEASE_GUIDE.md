# Ship release guide

Ship uses root Changesets and independent package versions. `fixed` and `linked` groups are empty. Published packages target the public `@sixthsummit` scope on npmjs.org. Existing GitHub Packages releases and historical receipts remain historical evidence; they are not npm publication receipts.

## Development and CI

Work on `dev`. Add a root changeset for consumer-visible changes with `pnpm changeset`. CI runs `pnpm release:preview` and uploads the exact pending version plan, including changeset IDs. Multiple pending changesets and dependency propagation can increase the final bump; review the combined plan before versioning. Changelogs use the built-in Changesets formatter, so version planning does not need a GitHub API token.

One CI workflow detects the complete PR diff (or the push range). API changes run API checks; Angular changes run Angular checks; shared contract, transport, CLI and joint-fixture changes run both. Root tooling, lockfile changes, unknown paths and missing comparison history run everything. Docs have separate jobs. The required `CI Summary` rejects failed or unexpectedly skipped jobs. Manual CI dispatch runs everything.

Local equivalents are `pnpm ci:api`, `pnpm ci:angular`, `pnpm docs:build`, and `pnpm --filter ship-angular docs:build`. API integration needs Docker. Angular browser conformance needs Chromium installed with `pnpm --filter ship-angular exec playwright install chromium`.

## Publishing is initially disabled

Release is manual and requires the repository variable `SHIP_PUBLISH_ENABLED=true`. A push or PR does not publish. The workflow accepts only `dev` (alpha) and `main` (latest), and serializes releases. Keep publishing disabled until the public launch is approved.

Before enabling it, establish package ownership in the npm `sixthsummit` organization and configure each package's [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/): GitHub organization `SixthSummit`, repository `Ship`, workflow `release.yml`, environment `npm`. The workflow uses GitHub-hosted runners, npm 11.6.2 and OIDC (`id-token: write`), with provenance. It has no registry token fallback. Complete the initial npm package/bootstrap setup with an organization owner before dispatching; creating the npm organization alone does not establish package publishers. Public provenance also requires the source repository to be public.

The `bootstrap` dispatch input explicitly permits packages absent from npm. On `dev` it includes every public workspace in the initial snapshot. Without it, absent packages fail planning instead of accidentally publishing the whole new namespace. This input does not supply authentication or authorize publication by itself.

## Alpha from dev

Dispatch Release on `dev` after setup. Changesets computes timestamped alpha versions for pending changes and their affected dependents. Snapshot edits remain ephemeral. The workflow queries npm, selects only changed versions absent from the registry, runs affected framework checks, builds their dependency closure, packs the selected packages, and uploads the plan and archives.

Every archive is checked against its planned name/version, registry, access, tag, SHA-256 integrity and resolved dependency ranges before any upload. npm publishes those exact archives under `alpha` in dependency order. Existing unchanged packages are excluded. No pending changes means no publication, except an explicit bootstrap.

## Stable from main

When ready, promote `dev` to `main`. On a release branch run `pnpm version-packages`; inspect the versions, dependency ranges, changelogs and lockfile, and merge through passing CI. Then manually dispatch Release on `main`. Stable planning refuses pending changesets and prerelease versions and selects only manifest versions absent from npm.

Version PRs, Git tags and GitHub Releases are not created automatically. Keep the required CI check on release branches; human review is not currently a branch-protection requirement. Merge stable version bookkeeping back into `dev` before further releases. Changesets pre mode is not used.

## Consumer acceptance and recovery

Pin exact versions for deployed consumers and test clean npm installs, application behavior and deployment previews before rollout. Local packed conformance proves the candidate archives, not registry publication or production acceptance. If publication fails partway through, inspect npm before retrying; stable planning skips already published versions. Alpha retries create a new snapshot. Published defects require a forward fix and, when appropriate, deprecation of the affected version.
