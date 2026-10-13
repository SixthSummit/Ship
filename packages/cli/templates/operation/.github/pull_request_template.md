## Why

<!-- State the problem, user impact, or invariant this PR addresses. -->

## What changed

<!-- Describe one logical change and any explicit non-scope. -->

## Contract and architecture

- [ ] Operation IDs, inputs, outputs, statuses, errors, access, transactions, and effects are unchanged.
- [ ] Changed behavior and its migration path are documented below.
- [ ] No hidden global state, ambient dependency, or undocumented deep import was introduced.

Contract notes:

## Test evidence

- [ ] AI-generated or AI-assisted tests were reviewed for correctness.
- [ ] New behavior and edge cases have colocated Vitest coverage.
- [ ] Tests are deterministic and clean up state.
- [ ] Changed source meets the 80% coverage threshold.
- [ ] `pnpm run verify` passes.

Commands and results:

```text
pnpm run verify
```

## Security, data, and release

- [ ] Auth, transaction, and external-effect boundaries are explicit or not applicable.
- [ ] No secret, credential, production data, or unsafe fallback was added.
- [ ] A Changeset is included for a published contract change, or this application change needs none.

Risk and rollback:

## Reviewer focus

<!-- Identify the assumption or code path reviewers should challenge first. -->
