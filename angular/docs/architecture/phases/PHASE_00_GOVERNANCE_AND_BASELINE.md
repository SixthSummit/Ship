# Phase 00: Governance and baseline

- **Status:** In progress
- **Checkpoint:** C0 — program authorized
- **Depends on:** completed redesign audit
- **Primary owners:** ShipAngular lead, ShipAPI lead, client-site owners

## Objective

Turn the accepted direction into an authorized cross-repository program with known consumers, measurable starting evidence, named owners, and no hidden compatibility assumptions.

## Scope

- review and accept ADR 0002 jointly with ShipAPI;
- approve the program, test gates, phase boundaries, and decision process;
- freeze the current framework/package/CI evidence baseline;
- define artifact retention and rollback expectations for pinned sites;
- identify the canary site and accountable owners; and
- create tracking issues/milestones for every phase and open decision.

No production API implementation changes belong in this phase.

## Work checklist

### Architecture and ownership

- [x] ShipAngular maintainer approves the audit findings and target boundary.
- [ ] ShipAPI maintainer confirms operation graph/client artifact responsibilities.
- [x] ADR 0002 is accepted with implementation syntax provisional until joint fixture conformance.
- [x] Old `CONTRACT.md` Hono resolution receives a “Superseded by ADR 0002” notice.
- [ ] Phase owners and reviewers are named.
- [ ] Cross-repository decisions have one shared tracking location.

### Client inventory

- [ ] Exact ShipAngular/ShipAPI pins and recoverable artifacts are recorded.
- [ ] Hono thunks, direct `hc`, generic REST, auth modes, SSR, transports, forms, and copied modules are counted.
- [ ] Complaints/workarounds are linked to characterization work.
- [ ] Each deferred site has an owner and review date.

### Baseline evidence

- [x] Record Node/pnpm versions and frozen-install result.
- [x] Record type, lint, format, build, test, coverage, Knip, bundle, and pack results.
- [x] Explain all failed/skipped tests and warnings.
- [x] Raise global branch coverage to 80% or approve only legitimate exclusions.
- [x] Capture root/package tarball contents and forbidden-dependency scan.
- [x] Capture Turbo task graph/timing and module/template coverage gaps.
- [x] Confirm the current docs mirror and clean scaffold behavior.

## Required tests and gates

- G0 change hygiene
- G1 static correctness
- G2 unit/integration behavior and 80% thresholds

Planning-only PRs do not need a Changeset unless they change documentation shipped inside the consumer package.

## Checkpoint review

Reviewers must answer:

1. Is every real client site visible, owned, and pinned?
2. Can every site restore its current framework artifact if migration fails?
3. Are ShipAPI and ShipAngular agreeing on the same client boundary?
4. Is current quality evidence reproducible from a clean checkout?
5. Are baseline failures converted to owned work rather than normalized as noise?

## Exit criteria

- [x] ADR 0002 accepted.
- [x] Program records approved for implementation on the redesign branch.
- [x] Canary selected.
- [x] Baseline checkpoint report linked.
- [x] Global coverage meets the company minimum in every metric.
- [ ] Phase 01 artifact names/owners and working session scheduled.

## Suggested commits

- `docs(core): define migration program`
- `test(core): close baseline coverage gaps`
- `docs(clients): record migration inventory`

Do not combine coverage code/tests, documentation, or generated inventory into an unrelated formatting commit.
