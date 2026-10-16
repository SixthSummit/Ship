# Ship release guide

Ship uses root Changesets and independent package versions. `fixed` and `linked` groups are empty. Published packages target the public `@sixthsummit` scope on npmjs.org. Existing GitHub Packages releases and historical receipts remain historical evidence; they are not npm publication receipts.

## Development and CI

Work on `dev`. Add a root changeset for consumer-visible changes with `pnpm changeset`. CI runs `pnpm release:preview` and uploads the exact pending version plan, including changeset IDs. Multiple pending changesets and dependency propagation can increase the final bump; review the combined plan before versioning. Changelogs use the built-in Changesets formatter, so version planning does not need a GitHub API token.

One CI workflow detects the complete PR diff (or the push range). API changes run API checks; Angular changes run Angular checks; shared contract, transport, CLI and joint-fixture changes run both. Root tooling, lockfile changes, unknown paths and missing comparison history run everything. Docs have separate jobs. The required `CI Summary` rejects failed or unexpectedly skipped jobs. Manual CI dispatch runs everything.

Local equivalents are `pnpm ci:api`, `pnpm ci:angular`, `pnpm docs:build`, and `pnpm --filter ship-angular docs:build`. API integration needs Docker. Angular browser conformance needs Chromium installed with `pnpm --filter ship-angular exec playwright install chromium`.

## Publishing configuration

Pushes to `dev` and `main` automatically start release preparation when `SHIP_PUBLISH_ENABLED=true`. The workflow accepts only `dev` (alpha) and `main` (latest), and serializes releases. Preparation computes the publication set, runs affected checks, and uploads verified archives. If there is nothing to publish, the publish job is skipped without requesting approval. Otherwise, the `npm` environment requires approval before the separate publish job starts. PR approval is not required. Manual dispatch remains available for retries and explicit bootstrap. Publishing has been enabled for the public launch. Keep the gate disabled in forks or before any new registry setup is complete.

For a new setup, establish package ownership in the npm `sixthsummit` organization and configure each package's [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/): GitHub organization `SixthSummit`, repository `Ship`, workflow `release.yml`, environment `npm`. The workflow uses GitHub-hosted runners, npm 11.6.2 and OIDC (`id-token: write`), with provenance. It has no registry token fallback. For packages that do not yet exist, an authenticated organization owner can stage a verified alpha archive with `npm stage publish <archive> --access public --tag alpha --provenance=false` using npm 11.15 or newer. npm creates a public `0.0.0-stage` placeholder while keeping the staged framework archive private. Configure trusted publishing with direct `npm publish` permission, then dispatch a fresh CI alpha version. Reject the temporary staged upload afterward; npm may require a separate browser/2FA approval per operation. The staged version cannot be reused by direct publication. Creating the npm organization alone does not establish package publishers. Public provenance also requires the source repository to be public.

When adding a new public package, complete its npm ownership/trusted-publisher setup before merging onto a branch with publishing enabled. Release planning deliberately fails for an unregistered package. The optional Web Push package starts at `0.0.0`; its Changeset establishes the first `0.1.0` stable release.

The `bootstrap` dispatch input explicitly permits packages absent from npm. On `dev` it includes every public workspace in the initial snapshot. Without it, absent packages fail planning instead of accidentally publishing the whole new namespace. This input does not supply authentication or authorize publication by itself.

## Alpha from dev

Merge changes into `dev` after setup. Changesets computes timestamped alpha versions for pending changes and their affected dependents. Snapshot edits remain ephemeral. The workflow queries npm, selects only changed versions absent from the registry, runs affected framework checks, builds their dependency closure, packs the selected packages, and uploads the plan and archives.

The preparation job summary and archived `review.md` show the exact package versions and pending Changeset descriptions (or version-specific changelog entries for stable releases). In GitHub Actions, open the Release run, inspect these details, then choose **Review deployments → npm → Approve and deploy**. The publish job downloads the same run’s immutable archives, revalidates them, and never rebuilds them. Configure required reviewers on the `npm` environment; self-approval is allowed so the maintainer who merged or dispatched can approve, and administrator bypass is disabled. Reject a queued release if it is no longer wanted.

Every archive is checked against its planned name/version, registry, access, tag, SHA-256 integrity and resolved dependency ranges before any upload. npm publishes those exact archives under `alpha` in dependency order. Existing unchanged packages are excluded. No pending changes means no publication, except an explicit bootstrap.

## Stable from main

When ready, promote `dev` to `main`. On a release branch run `pnpm version-packages`; inspect the versions, dependency ranges, changelogs and lockfile, and merge through passing CI. The merge automatically prepares a stable release; approve its publish job after checking the workflow summary. Stable planning refuses pending changesets and prerelease versions and selects only manifest versions absent from npm.

Version PRs, Git tags and GitHub Releases are not created automatically. Keep the required CI check on release branches; human review is not currently a branch-protection requirement. Merge stable version bookkeeping back into `dev` before further releases. Changesets pre mode is not used.

## Consumer acceptance and recovery

Pin exact versions for deployed consumers and test clean npm installs, application behavior and deployment previews before rollout. Local packed conformance proves the candidate archives, not registry publication or production acceptance. If publication fails partway through, inspect npm before retrying; stable planning skips already published versions. Alpha retries create a new snapshot. Published defects require a forward fix and, when appropriate, deprecation of the affected version.
