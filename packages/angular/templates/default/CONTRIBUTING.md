# Contributing

Use small, reviewable changes with tests and a rollback path.

## Commits

Follow Conventional Commits:

```text
<type>[optional scope]: <imperative description>
```

Supported types are `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, and `chore`. Use `fix` only for user-facing defects. Mark breaking changes with `!` or a `BREAKING CHANGE:` footer. Keep subjects under 50 characters when practical and omit the final period.

Enable the included template:

```bash
git config commit.template .gitmessage
```

## Tests

- Use Vitest for unit and integration tests.
- Colocate new tests as `FileName.test.ts`.
- Verify one behavior per test with deterministic fakes/local fixtures.
- Review AI-generated assertions for correctness, regression sensitivity, errors, and edge cases.
- Keep statements, branches, functions, and lines at or above 80% globally and for changed source files.
- Do not leave required tests skipped or depend on live production/provider systems.

Run:

```bash
pnpm type-check
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm build-prod
```

## Pull requests

Use `.github/PULL_REQUEST_TEMPLATE.md`. Record test/coverage evidence, consumer impact, risk, rollout, and rollback. Isolate formatting, dependency/lockfile, generated output, and large mechanical changes from behavioral work.
