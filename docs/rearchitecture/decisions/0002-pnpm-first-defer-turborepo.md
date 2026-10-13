# ADR-0002: Adopt pnpm first and defer Turborepo

- **Status:** Accepted
- **Date:** 2026-09-03
- **Scope:** ShipAPI framework monorepo dependency and task orchestration

## Context

ShipAPI currently uses npm workspaces with one root lockfile. The redesign expects core, HTTP, database, auth, observability, testing, and CLI packages to become explicit workspace packages.

That package split makes undeclared dependencies, accidental root dependency access, local-package resolution, dependency cycles, install performance, and filtered checks more important. It also creates a potential need for task scheduling and caching.

pnpm and Turborepo solve different problems:

- pnpm owns dependency installation, workspace linking, package filtering, and the lockfile;
- Turborepo schedules and caches scripts declared by workspace packages.

The architecture must not depend on either tool for application correctness. The Ship application graph and the monorepo build-task graph are separate concepts.

## Decision

### Adopt pnpm early

Migrate the ShipAPI framework monorepo from npm workspaces to pnpm in a dedicated infrastructure PR before splitting the new adapters into many packages.

The migration should:

- add `pnpm-workspace.yaml` and one root `pnpm-lock.yaml`;
- pin the package manager version in `package.json`;
- use `workspace:` for internal package dependencies so a missing local package cannot silently resolve from the registry;
- reject workspace dependency cycles;
- make every package declare the dependencies it imports;
- preserve Changesets, package publication, packed-consumer proof, and GitHub Packages behavior;
- update CI, release, security audit, documentation, and clean-consumer commands in the same bounded change;
- remove `package-lock.json` only after clean install, build, test, pack, and publish-dry-run parity is proven.

This decision applies to the framework monorepo. It does not require every ShipAPI consumer or generated application to change package managers.

pnpm's documented workspace protocol refuses to resolve a `workspace:` dependency from anywhere except the local workspace and rewrites workspace ranges to normal versions when packages are packed or published. Its shared workspace lockfile retains strict access to declared dependencies. These properties directly support the redesign's package-boundary goals.

References:

- [pnpm workspaces and `workspace:` protocol](https://pnpm.io/workspaces)
- [pnpm filtering](https://pnpm.io/filtering)

### Defer Turborepo

Do not add Turborepo in the pnpm migration PR.

First establish the new package graph and record uncached install, build, type-check, unit, integration, documentation, and packed-consumer timings. pnpm's filtered and recursive commands are sufficient for the initial graph.

Reconsider Turborepo when measurements show that dependency-aware parallel execution or local/remote caching would materially reduce feedback or CI time. A later ADR must define:

- the exact task graph and package scripts;
- cacheable outputs and complete input/environment hashing;
- tasks that must never be cached;
- local versus remote cache policy, credentials, retention, and trust;
- cache correctness tests and a simple no-cache escape path;
- measured before/after feedback and CI time.

Turborepo's task graph and output caching are useful once those inputs and outputs are stable. Adding it before then would encode a temporary package layout and create cache configuration work during architectural discovery.

References:

- [Turborepo task configuration](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/configuration.mdx)
- [Turborepo caching](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/caching.mdx)

## Consequences

### Positive

- Internal package dependencies become explicit and deterministic.
- Phantom dependencies that happen to exist at the workspace root are less likely to mask package defects.
- Workspace dependencies cannot silently resolve to a registry package.
- Filtered package checks support the redesign's bounded feedback loop.
- Package publication remains compatible because workspace ranges are converted during packing and publishing.
- The repository avoids committing to a cache graph before tasks and package outputs stabilize.

### Negative

- CI, release automation, audit commands, contributor instructions, and maintainer habits must migrate together.
- Existing npm-specific scripts and audit assumptions need explicit replacements and parity proof.
- Supporting contributors using a different package manager requires a clear error rather than a partially working install.
- Turbo's potential CI acceleration is postponed until baseline measurements exist.

### Risks

- A mechanical lockfile conversion could unintentionally change resolved dependency versions. Compare production trees and security findings before merging.
- GitHub Packages authentication and Changesets publishing may behave differently if only local development is tested. Prove registry and packed-consumer paths.
- pnpm strictness may initially reveal undeclared dependencies. Treat those failures as boundary defects, not reasons to enable broad hoisting.
- A future Turbo cache could return stale outputs if inputs or environment variables are incomplete. That is why cache adoption requires a separate decision and evidence.

## Acceptance evidence

The package-manager direction is accepted. Implementation is complete only when:

- clean local and CI installs use the pinned pnpm version;
- every workspace builds and tests without phantom dependencies;
- integration, parity, edge, docs, skills, and security jobs pass through pnpm commands;
- Changesets computes the intended versions;
- packed artifacts contain the intended files and dependency ranges;
- a clean external consumer installs and boots the packed artifact;
- GitHub Packages publication is proven without credential leakage;
- npm lockfile removal is isolated and reviewed.

Turborepo remains deferred until a new ADR accepts it from measured task data.

## Implementation note — 2026-09-07

Independent clean builds exposed nondeterministic workspace-dependency ordering in packed manifests
under both pnpm 10.8.1 and 10.34.5. The workspace now pins the maintained 10.34.5 release and uses a
root `beforePacking` hook to sort every publish-time dependency map after `workspace:` conversion.
`pnpm run test:pack` rebuilds and packs all publishable workspaces twice and fails on any version,
size, or SHA-256 difference. This makes the ADR's reproducibility requirement executable while
leaving Turborepo deferred.
