# ShipAngular rearchitecture program

> Historical planning/evidence record. Status, versions, branches, and test counts
> below describe the original checkpoint, not the current release. Current release
> instructions are in `RELEASE_GUIDE.md`; package changelogs record shipped changes.

> Program status: the Angular-side redesign and synthetic conformance implementation are complete
> on `audit/operation-client-redesign`. C1 remains open until ShipAPI supplies its exact packed
> artifact manifest and `pnpm test:joint-conformance` passes without fallback; client migrations
> remain open under C8. Application deployments are tracked outside this repository.
> migration, not greenfield housekeeping.

## Outcome

ShipAngular becomes the stable Angular frontend framework for ShipAPI's operation-centric application kernel. The finished framework must let an engineer or coding agent discover valid operations, construct typed inputs, handle every declared result, and use browser/SSR transports without reconstructing backend conventions or following prompt-only recipes.

The redesign preserves the good Angular foundation and replaces the weak backend seam. It does not merge ShipAngular and ShipAPI, move backend responsibilities into the browser, or couple third-party REST helpers to ShipAPI.

## Source records

- [SHIPANGULAR_REDESIGN_AUDIT.md](SHIPANGULAR_REDESIGN_AUDIT.md) — evidence and findings
- [CURRENT_COUPLING_MAP.md](CURRENT_COUPLING_MAP.md) — exact v4/Hono inventory
- [decisions/0002-operation-client-contract.md](decisions/0002-operation-client-contract.md) — proposed architecture decision
- [JOINT_CONFORMANCE_PLAN.md](JOINT_CONFORMANCE_PLAN.md) — cross-repository fixture and ownership
- [TESTING_GATES.md](TESTING_GATES.md) — mandatory gates and evidence
- [CLIENT_MIGRATION_PLAYBOOK.md](CLIENT_MIGRATION_PLAYBOOK.md) — pinned-site inventory, cohorts, rollout, and rollback

## Non-negotiable principles

1. ShipAngular remains frontend-only.
2. Stable operation IDs and a client-safe generated contract replace Hono route trees as the target frontend seam.
3. Declared application failures are typed values; cancellation, transport, protocol, and programmer failures remain distinct exceptions.
4. Angular owns dependency injection, signals/resources, browser behavior, SSR request context, and presentation adaptation.
5. ShipAPI owns the operation graph, client projection, transport serialization, and default structural operation client.
6. Auth, CSRF, request IDs, idempotency, cancellation, timeout, and retries form one operation-aware policy pipeline.
7. Unsafe operations are never retried without an explicit idempotency contract and stable key.
8. Upload, download, stream, and socket behavior use explicit capabilities rather than pretending every response is JSON.
9. Third-party REST support remains independent and cannot inherit ShipAPI credentials or policy accidentally.
10. Required integration evidence uses packed artifacts, deterministic local systems, and zero optional skips.
11. Every shipped source/template/module participates in type, lint/compiler, test, dependency, and package-content checks.
12. Existing client pins remain intact until each site has a verified migration and rollback window.

## Status vocabulary

Every phase uses exactly one state:

- **Proposed** — scope is drafted but entry gate is not approved.
- **Ready** — prerequisites and entry evidence are satisfied.
- **In progress** — implementation work is active.
- **Blocked** — a named decision or dependency prevents meaningful progress.
- **Verifying** — implementation is complete and exit evidence is being collected.
- **Complete** — the phase's owned implementation and local exit gate are approved with linked
  evidence. Explicitly transferred exact-artifact work remains under C1, and client rollout remains
  under C8; a completed Angular phase does not claim those gates have passed.

Update the phase table and the corresponding phase record in the same PR that changes status.
“Complete” is not a subjective label: owned artifacts, tests, and measurements must be linked, and
any dependent work must be transferred explicitly to C1 or C8 rather than hidden.

## Phase dashboard

| Phase | Record                                                                               | Current status | Primary result                                                        | Exit checkpoint              |
| ----- | ------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------- | ---------------------------- |
| 00    | [Governance and baseline](phases/PHASE_00_GOVERNANCE_AND_BASELINE.md)                | In progress    | Accepted ADR and framework evidence baseline                          | C0: program authorized       |
| 01    | [Packed contract conformance](phases/PHASE_01_PACKED_CONTRACT_CONFORMANCE.md)        | In progress    | ShipAPI contract/client tarballs consumed without source links        | C1: boundary proven          |
| 02    | [Operation kernel](phases/PHASE_02_OPERATION_KERNEL.md)                              | Complete       | Results, errors, typed provider, SSR context, request-policy pipeline | C2: unary kernel proven      |
| 03    | [Resources and client compatibility](phases/PHASE_03_RESOURCES_AND_COMPATIBILITY.md) | Complete       | Explicit resources/mutations plus temporary Hono and URL adapters     | C3: vertical slice proven    |
| 04    | [Authentication and SSR](phases/PHASE_04_AUTH_AND_SSR.md)                            | Complete       | Honest auth state, current credentials, cross-user isolation          | C4: identity boundary proven |
| 05    | [Transport capabilities](phases/PHASE_05_TRANSPORT_CAPABILITIES.md)                  | Complete       | Upload, download, stream, and socket capabilities                     | C5: browser protocols proven |
| 06    | [Forms, modules, and package surface](phases/PHASE_06_FORMS_MODULES_PACKAGING.md)    | Complete       | Client-safe forms and every shipped surface in the quality graph      | C6: package surface proven   |
| 07    | [Toolchain, CI, and agent controls](phases/PHASE_07_TOOLCHAIN_CI_AGENT_CONTROLS.md)  | Complete       | pnpm, selective Biome, corrected task graph, enforceable docs/prompts | C7: release proof automated  |
| 08    | [Client migration and release](phases/PHASE_08_CLIENT_MIGRATION_RELEASE.md)          | In progress    | Every pinned site upgraded or dispositioned with evidence             | C8: migration complete       |

## Dependency chain

```text
Phase 00: decision + inventory + baseline
  -> Phase 01: packed cross-repo contract
    -> Phase 02: operation kernel
      -> Phase 03: first Angular vertical slice + compatibility
        -> Phase 04: auth/SSR
        -> Phase 05: non-JSON capabilities
          -> Phase 06: forms/modules/package surface
            -> Phase 07: final toolchain and CI enforcement
              -> Phase 08: client cohorts and compatibility removal
```

Phases 04 and 05 may overlap only after Phase 03's vertical slice is complete. Tool experiments may run earlier, but lockfile-wide formatting or task-runner migrations wait until their relevant correctness gates exist.

## Program checkpoints

### C0 — Program authorized

- ADR 0002 accepted by ShipAngular and ShipAPI maintainers.
- Known client sites and owners are inventoried.
- Current version, auth mode, API patterns, modules, SSR use, and special transports are recorded per site.
- Existing production pins and rollback procedures are confirmed.
- Baseline test, coverage, bundle, tarball, and CI gaps are captured.

### C1 — Boundary proven

- ShipAPI deterministically produces a browser contract and client fixture.
- ShipAngular consumes packed tarballs in a clean project.
- Negative type cases fail for wrong operation IDs/input locations/status assumptions.
- Forbidden server dependencies are absent from tarballs and browser bundles.
- Required conformance cannot silently skip.

### C2 — Unary kernel proven

- Declared failures preserve status, details, headers, and request ID as values.
- Network, abort, timeout, malformed JSON, and proxy HTML are distinct.
- The provider is type-safe in browser and request-safe under concurrent SSR.
- Request policy is origin-scoped, abortable, and mutation-safe.

### C3 — Vertical slice proven

- One read and one mutation flow through contract → client → DI → resource/mutation → component fixture.
- Input signals retrigger; stale responses cannot win; cancellation reaches I/O.
- Hono v4 adapter passes the supported subset of the same conformance runner.
- Generic third-party REST works without ShipAPI installed.

### C4 — Identity boundary proven

- Bearer, cookie session, CSRF, refresh, denial, and sign-out failure are distinguishable.
- Auth state never claims a server session ended when termination failed.
- Concurrent SSR requests cannot share credentials or request context.

### C5 — Browser protocols proven

- Upload/download/SSE/WebSocket fixtures pass in a real browser.
- Credentials use the common policy and never appear in query strings/logs.
- Progress, bytes, event/message codecs, reconnect, close, abort, and race semantics are deterministic.

### C6 — Package surface proven

- Form schemas are browser-safe and preserve omitted/null/empty semantics.
- Maintained modules are compiled workspaces/entrypoints; examples are applications; generated code is explicitly app-owned.
- No shipped source is ignored by type, lint/compiler, tests, Knip, or package inspection.
- Every secondary entrypoint has a budget and clean-consumer proof.

### C7 — Release proof automated

- Frozen pnpm install, Changesets, pack/publish dry run, docs, Angular CLI, and all fixture apps pass.
- Biome owns only demonstrated rule/format coverage; Angular ESLint/compiler checks remain where required.
- Turbo has a correct measured task graph or has been removed in favor of simpler pnpm orchestration.
- Agent instructions, examples, and generated docs compile against the current public API.

### C8 — Migration complete

- Every in-scope pinned site has a recorded outcome: upgraded, explicitly deferred with owner/date, or retired.
- Upgraded sites pass staging, production smoke, telemetry review, and rollback window.
- Old pins/artifacts remain recoverable according to retention policy.
- Hono and legacy-REST compatibility removal is a separate breaking change after the migration gate.

## Delivery rules

### Pull requests

- One phase may use multiple PRs; one PR should deliver one coherent review unit.
- Every PR identifies its phase, checkpoint impact, risk, rollback, and test evidence.
- Behavior and its tests land together.
- Mechanical formatting, package-manager, generated-output, and mass-rename changes are isolated from behavior.
- Public behavior changes include a Changeset. Internal planning/CI-only changes do not create consumer releases.
- A phase cannot hide a failed or skipped required gate behind “follow-up work.”

### Commits

Use Conventional Commits and imperative subjects under 50 characters. Prefer these scopes for this program:

- `contract`, `operations`, `resource`, `transport`, `auth`, `ssr`, `forms`
- `modules`, `cli`, `testing`, `docs`, `build`, `ci`, `deps`

Use `feat!` or a `BREAKING CHANGE:` footer when a committed public API break is intentionally introduced. Do not label CI/test/documentation repairs as `fix` merely because they correct a problem.

### Tests

- Vitest is the unit/integration framework.
- New tests use colocated `FileName.test.ts`; existing `.spec.ts` files remain recognized until an isolated rename/migration.
- Tests normally accompany the feature/fix commit. `test:` is reserved for test-only changes.
- Engineers must review generated tests for correctness; “AI generated” is not evidence by itself.
- The [testing gates](TESTING_GATES.md) apply to every phase.

## Program metrics

Track these in each checkpoint report:

| Metric                                              | Target                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Required skipped tests                              | 0                                                                                           |
| Changed-file coverage                               | at least 80% statements, branches, functions, and lines                                     |
| Global coverage                                     | at least 80% in all four metrics before architecture code merges; ratchet upward thereafter |
| Unverified shipped TypeScript/templates             | 0 by C6                                                                                     |
| Source/workspace-linked cross-repo tests            | 0 by C1                                                                                     |
| Undeclared runtime dependencies                     | 0                                                                                           |
| Server-only imports in browser artifacts            | 0                                                                                           |
| Cross-user SSR context leaks                        | 0                                                                                           |
| Unsafe mutation retries without contract/key        | 0                                                                                           |
| Documentation examples that do not compile          | 0 by C7                                                                                     |
| Client migrations without staging/rollback evidence | 0                                                                                           |

## Decision and risk log

Record material decisions as ADRs, not buried phase notes. Each phase record contains local open questions, but a question that changes cross-repository types, public behavior, security policy, or migration promises requires an ADR or an amendment to ADR 0002.

Highest program risks:

1. ShipAPI and ShipAngular finalize different artifact shapes. Mitigation: Phase 01 joint fixture is the decision surface.
2. Compatibility logic contaminates the target interface. Mitigation: named entrypoint, shared conformance, explicit limitations, removal gate.
3. Client migration uncovers undocumented v4 behavior. Mitigation: Phase 00 site inventory and Phase 03 adapter diagnostics before cohorts.
4. Auth/SSR leaks credentials across origins or users. Mitigation: origin policy plus concurrent A/B SSR and redaction tests.
5. Tool migrations obscure behavior regressions. Mitigation: Phase 07 isolation and frozen baseline evidence.

## Definition of program complete

The program is complete only when C8 is approved, the clean packed browser/SSR consumers pass, every shipped surface is governed by the quality graph, future ShipAPI graph changes produce deterministic contract compatibility evidence without human reconstruction of routes or protocols.
