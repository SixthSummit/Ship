# Phase 06: Forms, modules, and package surface

- **Status:** Complete — Angular form, module, and package implementation accepted; joint artifact syntax remains under C1
- **Checkpoint:** C6 — package surface proven
- **Depends on:** C3 operation inputs; C5 capability components
- **Primary owners:** forms owner, package owner, module owners

## Objective

Make form schemas client-safe and put every maintained/shipped feature behind a real compiled, tested, analyzable package boundary.

## Subphase 6A — Form schema decision

- [x] Compare generated bindings, browser-safe Zod, and generic schema interpretation in ADR 0003.
- [x] Record package/runtime size and tree-shaking implications for the chosen binding direction.
- [x] Identify unsupported async/server-only refinements explicitly.
- [ ] Confirm ADR 0003's generated binding syntax with ShipAPI through the joint fixture.
- [x] Keep optional runtime validators out of the default operation forms entrypoint.

## Subphase 6B — Typed form implementation

- [x] Remove `Record<string, FormControl>` plus double-cast construction from the operation forms path.
- [x] Infer/build actual control structure from the supported client-safe projection.
- [x] Preserve omitted, null, empty string, zero, false, and empty collection semantics.
- [x] Map stable validation issue paths/codes/messages without message parsing.
- [x] Support explicit codecs and require generated bindings for nontrivial wire values.
- [x] Treat client validation as UX assistance; server results remain authoritative.
- [x] Prevent Drizzle/server module imports from browser/runtime/declarations.

## Subphase 6C — Module ownership

Inventory every current `modules/*` item and choose exactly one disposition:

- **compiled framework feature** — becomes a workspace package/secondary entrypoint with public API and owner;
- **example application** — demonstrates integration but is not shipped as framework runtime;
- **app-owned generator** — schematic output belongs to the consumer and has a migration story; or
- **remove** — stub, duplicate, unsafe, or unsupported code.

Specific required decisions:

- [x] remove the unsafe browser AI provider catalog rather than shipping provider credentials/tools;
- [x] replace copied forms/upload behavior with compiled capability entrypoints;
- [x] classify billing/dashboard/admin/profile/team as application-owned ideas, not maintained framework packages;
- [x] remove roadmap stubs from the published package;
- [ ] preserve local module customizations through explicit client migration records.

## Subphase 6D — Package surface

- [x] Add approved Angular secondary entrypoints.
- [x] Define one-way dependencies and prevent cycles.
- [x] Compile all maintained sources with strict settings.
- [x] Include consumer-facing ESLint/schematics/assets intentionally.
- [x] Remove silent catalog copying and verify required build outputs.
- [x] Make Knip and package inspection cover every shipped project.
- [x] Add per-entrypoint API and bundle budgets.
- [x] Keep package-root compatibility re-exports only for the documented window.

## Required tests and gates

- G0–G3 and G5 for every package/form change
- form compile-time and runtime shape tests
- omitted/null/empty/codec/validation issue tests
- browser bundle comparisons for schema options
- clean import/tree-shaking tests per entrypoint
- module example builds and critical component tests
- package tarball allowlist and missing-asset failure tests
- no ignored shipped files in TypeScript, Angular compiler, lint, coverage, or Knip

## Checkpoint review

Review the schema comparison with measurements, the disposition table for every module, the dependency graph, and actual tarball contents. Demonstrate that an application not using forms/upload/socket does not pay their optional runtime cost.

## Exit criteria

- [ ] Client-safe schema decision is accepted and measured.
- [x] Form control types match runtime controls without double casting.
- [x] Every module has an owner/disposition and migration impact.
- [x] Every shipped source participates in the quality graph.
- [x] All secondary entrypoints pack, import, and have individual artifact budgets.
- [x] Package omissions fail the build.
- [ ] Client inventory records local copied-module modifications.

## Local evidence

- The packed-package gate imports every secondary entrypoint without a workspace or sibling-repository link and fails on missing public artifacts.
- The bundle gate measures runtime and declarations per entrypoint. The current aggregate is 97.36 KiB gzip; Firebase remains isolated in the optional `/firebase-auth` entrypoint.
- Operation-form type/runtime tests cover omitted, null, empty, validation issue, and codec behavior. ShipAPI acceptance of the generated binding syntax remains a C1/C6 coordination item.

## Suggested commits

- `test(forms): compare schema adapters`
- `feat(forms): use client-safe schemas`
- `refactor(modules): classify feature code`
- `build(core): add secondary entrypoints`

Keep module moves and broad generated formatting separate from form behavior.
