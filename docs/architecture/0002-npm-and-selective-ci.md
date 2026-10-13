# ADR-0002: npm distribution and selective monorepo CI

- Status: Accepted; publication enabled for the public launch
- Date: 2026-10-12

## Context

API and Angular share a pnpm/Turbo repository but retain independent package versions. The npm `sixthsummit` organization is the selected destination for public packages. Running all framework gates on every isolated change is unnecessary, while shared contracts must retain joint conformance.

## Decision

Keep Changesets and preview its full pending release plan in CI. Use one change-planning workflow with API, Angular and documentation jobs and one required `CI Summary`. Shared tooling and unknown paths select all checks. Changes affecting the joint contract, transport and CLI select both frameworks. A failed planner or an unexpectedly skipped selected job fails the summary.

Use public npmjs package metadata and token-free consumer installation. Publishing is a separate, manually dispatched workflow, disabled by default. Alpha versions come from `dev`; stable versions require explicit Changesets version bookkeeping on `main`. Query npm and pack only the selected absent versions. Verify archive identity and dependency resolution before uploading the exact archives with npm trusted publishing and provenance. First publication requires explicit bootstrap setup. The initial preparation kept the source private; the subsequent public launch enables the repository publishing gate.

## Consequences

API-only and Angular-only edits avoid the other framework's full verification, while shared changes retain integration coverage. Angular joint conformance still builds the API fixture dependencies. Root dependency changes deliberately run all checks. Changesets remains responsible for version calculation; CI exposes aggregation and dependency-driven bumps for inspection. Maintainers configure npm trusted publishing per package before launch, and retain historical GitHub registry receipts unchanged.

The [release guide](../../RELEASE_GUIDE.md) contains operational steps.
