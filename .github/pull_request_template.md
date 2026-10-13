## Why

<!-- State the problem, user impact, or invariant this PR addresses. -->

## What changed

<!-- Describe the smallest logical change. Call out explicit non-scope. -->

## Change classification

- [ ] Consumer-visible feature
- [ ] User-facing bug or security fix
- [ ] Behavior-preserving refactor or performance work
- [ ] Tests, documentation, CI, build, dependency, or maintenance only
- [ ] Breaking change

Affected package, module, or trust zone:

## Contract and architecture

- [ ] Public API, operation, route, error, auth, database, or configuration behavior is unchanged.
- [ ] Changed behavior and its migration path are described below.
- [ ] Relevant ADR, RFC, issue, or invariant is linked below.
- [ ] No hidden global state, import-time mutation, ambient dependency, or undocumented deep import was introduced.

Contract or architecture notes:

## Test evidence

<!-- Tests use Vitest and are colocated as FileName.test.ts where applicable. -->

- [ ] New or changed behavior has corresponding tests.
- [ ] Each test verifies a meaningful behavior or failure mode.
- [ ] Tests are deterministic and clean up mutable state.
- [ ] External systems are mocked at their boundary or exercised through an approved integration fixture.
- [ ] AI-generated or AI-assisted tests were reviewed for correctness and completeness.
- [ ] No test is skipped without a documented reason.
- [ ] The applicable coverage gate passes; changed production behavior meets the 80% coverage target where measured.

Tests added or changed:

```text
<!-- List test files and the behaviors they prove. -->
```

Commands run and results:

```text
pnpm run ci
# pnpm run test:integration       # database/infrastructure behavior
# pnpm run test:parity            # runtime/tooling or contract parity
# pnpm run test:edge              # edge-compatible HTTP surface
# pnpm run test:pack              # exact published artifact
# pnpm run docs:build             # documentation application changes
# pnpm run audit:runtime          # published dependency changes
# pnpm run verify                 # full phase boundary
```

If an applicable command was not run, explain why:

## Security and data review

- [ ] No secret, credential, production data, or unsafe fallback was added.
- [ ] Authentication and authorization run at the correct boundary.
- [ ] Database writes use the intended transaction and rollback path.
- [ ] External effects identify their retry, idempotency, and failure behavior.
- [ ] Dependency changes identify whether exposure is runtime, optional adapter, build/test tooling, or documentation only.
- [ ] Not applicable; this PR has no security, data, dependency, or external-effect impact.

Security/data notes:

## Release and documentation

- [ ] A Changeset is included for every consumer-visible package change.
- [ ] No Changeset is required; the reason is recorded below.
- [ ] Load-bearing documentation and executable examples agree with the implementation.
- [ ] Breaking changes include a migration path and `BREAKING CHANGE` communication.

Changeset or no-Changeset reason:

## Risk and rollback

Risk level: <!-- low / medium / high / critical -->

Failure or stop conditions:

Rollback or forward-fix plan:

## Reviewer focus

<!-- Identify the assumptions and code paths reviewers should challenge first. -->
