## Summary

<!-- What outcome does this deliver, and why is it needed? -->

## Program context

- Phase/checkpoint: <!-- e.g. Phase 02 / C2, or N/A -->
- Tracking issue/ADR:
- Change type: <!-- feature, user-facing fix, refactor, test, build, CI, docs, maintenance -->

## Consumer and compatibility impact

<!-- Public API, behavior, bundle, configuration, generated code, ShipAPI contract, or client-site impact. -->

- [ ] No consumer-visible impact
- [ ] Backward-compatible consumer change
- [ ] Breaking change documented below
- [ ] Hono v4 compatibility behavior affected
- [ ] Pre-Hono legacy REST compatibility behavior affected
- [ ] Pinned client-site migration required

Breaking/migration details:

## Implementation

<!-- Important design choices and intentionally excluded work. -->

## Test evidence

Commands and CI links:

```text

```

| Evidence                        | Result |
| ------------------------------- | ------ |
| Tests passed / failed / skipped |        |
| Statements coverage             |        |
| Branch coverage                 |        |
| Function coverage               |        |
| Line coverage                   |        |
| Changed-file coverage           |        |
| Packed/clean-consumer proof     |        |
| Bundle impact                   |        |
| Browser/SSR conformance         |        |
| Contract manifest / graph hash  |        |

AI-generated tests reviewed for correctness and failure sensitivity by:

## Risk, rollout, and rollback

Risk level and failure modes:

Rollout/checkpoint plan:

Rollback version, artifact, command/process, and owner:

## Security and privacy

<!-- Address credentials, cookies, CSRF, origins, request IDs, SSR isolation, validation details, logs, uploads, streams, or sockets as applicable. -->

## Checklist

- [ ] Commits and PR title follow Conventional Commits with an imperative subject
- [ ] One coherent change is included; mechanical churn is isolated
- [ ] New/changed behavior has colocated Vitest coverage
- [ ] AI-generated tests were reviewed for correctness and edge cases
- [ ] All required tests pass locally and in CI
- [ ] No required test is skipped; any optional skip has reason, owner, and removal condition
- [ ] Global and changed-file coverage meet 80% for statements, branches, functions, and lines
- [ ] TypeScript, Angular template/compiler, lint, and format checks pass
- [ ] Errors, cancellation, cleanup, concurrency, retry, and redaction were considered
- [ ] Browser and SSR behavior are tested where applicable
- [ ] Packed public boundaries and forbidden imports are tested where applicable
- [ ] Bundle/package impact is measured where applicable
- [ ] Documentation, schematics, examples, skills, and evals are updated where applicable
- [ ] A Changeset is included for consumer-visible changes, or the omission is explained
- [ ] Breaking changes include `!` or a `BREAKING CHANGE:` footer and a migration path
- [ ] Pinned client-site rollout/rollback evidence is linked where applicable

Changeset decision:

## Reviewer notes

<!-- Unresolved decisions, follow-up issues with owner/date, and checkpoint approvals. -->
