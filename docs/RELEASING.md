# Releasing ShipAPI

Changesets owns versions, changelogs, GitHub Packages publication, tags, and
GitHub Releases. The detailed operator runbook is
[maintainers/RELEASE_GUIDE.md](./maintainers/RELEASE_GUIDE.md). This page defines
the package set and the evidence required before that automation is allowed to
publish.

Do not run `changeset version`, `changeset publish`, `pnpm run
version-packages`, or `pnpm run release` from a developer checkout. The release
workflow performs those mutations: snapshot prereleases on `dev`, and stable
releases through its Version Packages PR on `main`.

## Published package set

| Package | Ownership |
| --- | --- |
| `@sixthsummit/ship-core` | Operation kernel, graph, execution, access, and capabilities |
| `@sixthsummit/ship-hono` | Hono HTTP and credential adapter |
| `@sixthsummit/ship-drizzle` | Drizzle unit of work and repository primitives |
| `@sixthsummit/ship-contract` | Browser-safe structural client and backend projectors |
| `@sixthsummit/ship-auth-firebase` | Optional Firebase Admin actor adapter |
| `@sixthsummit/ship-cache-redis` | Redis declared-read-cache backend |
| `@sixthsummit/ship-jobs-bullmq` | BullMQ jobs backend |
| `@sixthsummit/ship-realtime-socketio` | Socket.IO + Redis realtime gateway |
| `@sixthsummit/ship-webhooks` | Provider webhook verifiers |
| `@sixthsummit/ship-observability-otel` | Optional OpenTelemetry adapter |
| `@sixthsummit/ship-testing` | Development-only parity and PostgreSQL fixtures |
| `@sixthsummit/ship-cli` | Application graph, contract, and migration tools |
| `@sixthsummit/ship-api` | V4 compatibility distribution and legacy scaffold tooling |
| `@sixthsummit/ship-api-mcp-server` | Optional local development MCP server |
| `@sixthsummit/ship-api-claude-plugin` | Optional Claude Code integration |

The docs application is private and never published. Focused packages have
independent versions; the release evidence records their exact tested set.

## Development changes

Every consumer-visible change includes a Changeset with the smallest correct
bump for every affected package:

```sh
pnpm exec changeset
```

The Changeset describes user impact and migration, not implementation history.
CI, tests, internal refactors, and repository-only docs do not need one.
Conventional Commit types communicate intent; they do not compute versions.

Inspect queued release intent without mutating package files:

```sh
pnpm exec changeset status --verbose
```

Changesets requires a local `main` ref for this repository's configured base
branch. If a fresh checkout contains only remote refs, create a tracking ref
before running local status:

```sh
git branch --track main origin/main
```

## Prerelease evidence

Before merging the Version Packages PR, run or obtain green CI evidence for:

```sh
pnpm install --frozen-lockfile
pnpm run verify
pnpm run check:skills
pnpm exec changeset status --verbose
```

`verify` covers source checks, all workspace type checks/builds, the repository
and coverage suites, real PostgreSQL, legacy parity, edge bundling, all packed
packages, two independent clean-build archive-identity passes, both golden
consumers, docs, and the hard runtime audit.

Review the Version Packages PR for:

- exactly the intended packages and bump levels;
- coherent internal dependency ranges;
- readable per-package changelogs and explicit breaking impact;
- one lockfile and no source/workspace dependency in packed manifests;
- no `.changeset/pre.json` (pre mode is retired); and
- the exact commit and check results that will be published.

The release workflow runs on `dev` and `main`, gated on the CI run for the
exact commit. On `dev`, a queued Changeset publishes a snapshot prerelease
(`<version>-alpha-<datetime>`) under the `alpha` dist-tag with no commit or
PR. On `main`, a queued Changeset opens or updates `chore: version packages`;
merging that checked PR causes the next run to build and publish stable
versions ahead of the registry to `latest`. Changesets creates per-package
`name@version` tags for stable releases only. Do not create bare version tags.

## Consumer acceptance

Publication proves artifact integrity, not application safety. A protected
consumer candidate must:

1. install exact versions from GitHub Packages in a clean environment;
2. commit its lockfile and package identities;
3. run its own Biome/lint, TypeScript, unit, coverage, integration, build, and
   route/contract gates;
4. prove any relevant database, auth, effect, runtime, and rollback behavior;
5. deploy to an isolated no-traffic preview before promotion; and
6. record the exact framework and consumer SHAs in its release evidence.

V4 GA has additional adoption gates in
[ADR-0012](./rearchitecture/decisions/0012-v4-replacement-and-release-boundary.md).
Do not promote `dev` to `main` merely because all package tests pass.

### Local exact-candidate rehearsal

Before registry publication, `candidate:pack` can bind the built ShipAPI graph and additional
package directories into one retained local manifest:

```sh
pnpm candidate:pack -- \
  --output /private/tmp/ship-framework-candidate-<commit> \
  --package ../ship-angular/packages/core \
  --package ../example-app/client-contract
```

Every package source must be committed. The command refuses to overwrite its output directory and
records each package's source repository/commit, version, relative archive path, byte size, and
SHA-256, plus a fingerprint over the sorted manifest. Consumers may use those archives to prove
that backend and frontend gates ran against the same physical bytes.

The repository pins pnpm 10.34.5 and applies a root `beforePacking` hook because pnpm's concurrent
`workspace:` conversion can reorder a publish-time dependency map across otherwise identical clean
builds. The hook sorts those converted maps; `test:pack:reproducible` then rebuilds and packs every
ShipAPI workspace twice and requires exact version, byte-size, and SHA-256 equality before a
candidate is accepted.

This is a publication rehearsal, not a publication. Local versions, a local manifest, and passing
consumer tests do not satisfy clean registry install, GitHub provenance, preview, rollback, or
traffic gates.

Retain candidate manifests and application acceptance evidence with the application release.

## Rollback

Published package versions are immutable. If a prerelease is bad, deprecate that
exact version with a safe reason, pin consumers to the prior verified manifest,
and publish a higher forward-fix version. Do not overwrite a tag or package and
do not use a moving `alpha` tag in a protected consumer.
