# Phase 07: Toolchain, CI, and agent controls

- **Status:** Complete — Angular toolchain and synthetic release proof accepted; exact joint artifacts remain under C1
- **Checkpoint:** C7 — release proof automated
- **Depends on:** C6 target package graph
- **Primary owners:** build/CI owner, developer-experience owner

## Objective

Make repository automation accurately enforce the architecture, migrate tooling without hiding behavioral changes, and ensure agent instructions describe APIs that compile.

## Subphase 7A — pnpm migration

- [x] Add `pnpm-workspace.yaml` for every real package/app/fixture.
- [x] Convert intentional internal references to `workspace:` ranges.
- [x] Remove the contaminated npm lock in an isolated reviewed commit.
- [x] Generate/freeze `pnpm-lock.yaml` and verify strict undeclared-dependency failures.
- [x] Update Changesets, release authentication, caches, scripts, docs, and generated template commands.
- [x] Finish clean generated-template install/build evidence; keep publish dry-run evidence for the release checkpoint.
- [x] Preserve ability for consumers to use npm; pnpm is the repository manager, not a runtime requirement.

## Subphase 7B — Biome and Angular linting

- [x] Inventory every Prettier/ESLint/custom/Angular template rule and assign an owner/tool.
- [x] Adopt Biome for formatting, imports, and supported TypeScript/JSON rules after a dry comparison.
- [x] Keep Angular ESLint/compiler checks for component metadata, DI, routes, and templates.
- [x] Retain custom rules where no proven equivalent exists.
- [x] Package/configure consumer-facing rules intentionally and narrow claims to enforced behavior.
- [x] Apply mechanical formatting in its own commit.
- [x] Ensure ignored local settings cannot break tracked-file format checks.

## Subphase 7C — Task graph

- [x] Remove Turbo phantom tasks and accidental docs dependencies.
- [x] Give every workspace explicit scripts and correct cache inputs/outputs.
- [x] Record cold/warm task timing and retain Turbo for the corrected graph.
- [x] Keep Turbo only for the demonstrated build/type/test graph.
- [ ] Otherwise use simpler pnpm recursive/filter orchestration.
- [x] Delete or repair stale parallel scripts invoking nonexistent commands.

## Subphase 7D — CI/release gates

- [x] Run all required tests and coverage on every PR/push to active trunks.
- [x] Enforce 80% in all global coverage metrics and document the changed-file requirement.
- [x] Remove optional required suites and fail when required packed inputs are absent.
- [x] Require packed local conformance, browser transports, forbidden imports, public API, and per-entrypoint bundles.
- [ ] Require real joint artifact and release-candidate concurrent SSR conformance.
- [x] Define a deliberate vulnerability policy instead of unconditional `continue-on-error`.
- [x] Verify canonical-doc mirror drift.
- [ ] Run release proof against exact tarballs and fixture manifest/hash.
- [x] Add Conventional Commit/PR-title validation consistent with Changesets.

## Subphase 7E — Agent and documentation controls

- [x] Replace Hono-first instructions with operation-client guidance; move v4 material to compatibility docs.
- [x] Finish updating skills, agents, Cursor rules, schematics, evals, and starter template, then validate the scaffold.
- [x] Compile documentation examples against packed public APIs.
- [x] Update eval graders to assert behavior rather than obsolete symbol spelling.
- [x] Ensure generated apps include the approved commit template and contribution/test guidance.
- [x] State which invariants are compiler/lint/test enforced and remove false claims.

## Required tests and gates

- complete G0–G5 on Node 20 and 22 where supported
- frozen offline-capable install after artifact acquisition
- clean cache and warm cache runs with identical outputs
- package/release dry run through Changesets
- tracked-file formatting and lint negative fixtures
- generated template/CLI smoke from packed package
- documentation example compilation and eval smoke

## Checkpoint review

Review the dependency/task graph, rule responsibility matrix, CI branch protections, cold/warm timing, and exact release tarballs. The review must distinguish faster tooling from stronger guarantees.

## Exit criteria

- [x] One authoritative local/CI command graph exists.
- [x] pnpm frozen installs and packed artifacts expose valid consumer ranges.
- [x] Biome and Angular tooling have explicit non-overlapping responsibilities.
- [x] Turbo is correct and justified.
- [ ] Full G0–G5 is required and green with zero required skips.
- [x] Docs, skills, evals, templates, and public declarations agree locally.
- [ ] Release candidate artifacts are reproducible from a clean checkout.

## Local evidence

- Repository, library, schematic, docs, generated-app, and packed-consumer TypeScript
  projects enable both `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- A fresh app generated from the packed framework passes type checking, packaged Angular ESLint rules, Biome/Prettier checks, 80%+ coverage, an SSR production build, and the Chromium render/accessibility smoke.
- Generated apps opt into Angular's LMDB cache only in CI. This avoids a reproducible native LMDB abort on local macOS while retaining CI caching.
- The packed conformance consumer compiles the documented shared operation boundary against only public package exports.
- The required `Packed browser conformance` CI job downloads the exact Node 22 build artifact,
  repacks it, compiles a strict public consumer, and runs deterministic cross-origin upload,
  download, SSE, and WebSocket cases in Chromium.
- Eval validation covers all nine task definitions. Recording scores now requires an explicit evaluated workspace and run ID, so untouched framework source can no longer be reported as agent output.

## Suggested commits

- `chore(deps): migrate workspace to pnpm`
- `style: apply biome formatting`
- `build(core): correct task graph`
- `ci(testing): enforce quality gates`
- `docs(agents): teach operation clients`

These commits remain separate even if developed in one phase.
