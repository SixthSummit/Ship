> Workspace setup and release workflow: [root contributing guide](../CONTRIBUTING.md), [release guide](../RELEASE_GUIDE.md). All Changesets are at the workspace root.

# Contributing to ShipAngular

ShipAngular is company platform infrastructure. Changes should be small enough to review, explicit about consumer impact, and backed by deterministic tests at the boundary they affect.

## Development workflow

1. Branch from the active `dev` trunk unless a release/rearchitecture plan says otherwise.
2. Keep one coherent behavior or maintenance concern per PR.
3. Add or update tests with the behavior.
4. Run the relevant local gates and record results in the PR template.
5. Add a Changeset for consumer-visible package/template/module changes. Merging into `dev` publishes an alpha snapshot of the pending changesets; stable versions ship from `main` (see `RELEASE_GUIDE.md`).
6. Use Conventional Commits for commits and the PR/squash title.
7. Preserve a rollback path for public behavior, release, and client-site migrations.

Architecture rework follows [the rearchitecture program](docs/architecture/REARCHITECTURE_PROGRAM.md) and [testing gates](docs/architecture/TESTING_GATES.md).

## Conventional Commits

Format:

```text
<type>[optional scope]: <imperative description>

[optional body]

[optional footer]
```

Keep the subject under 50 characters when practical, omit the final period, and describe what the commit does in imperative mood.

| Type       | Use                                            | Release meaning            |
| ---------- | ---------------------------------------------- | -------------------------- |
| `feat`     | Add consumer/developer functionality           | minor                      |
| `fix`      | Correct a user-facing defect                   | patch                      |
| `perf`     | Improve performance without changing behavior  | patch                      |
| `refactor` | Restructure without changing external behavior | patch under company policy |
| `docs`     | Documentation only                             | none                       |
| `style`    | Formatting/cosmetic only                       | none                       |
| `test`     | Test-only change                               | none                       |
| `build`    | Build/compiler/bundler configuration           | none                       |
| `ci`       | CI/CD automation                               | none                       |
| `chore`    | Other maintenance/dependency/lockfile work     | none                       |

Use `fix` only for behavior users experience. CI repairs use `ci`, test repairs use `test`, documentation uses `docs`, and internal maintenance uses the closest non-release type.

Recommended scopes include:

- `core`, `api`, `contract`, `operations`, `resource`, `transport`
- `auth`, `ssr`, `forms`, `modules`, `cli`
- `testing`, `docs`, `config`, `build`, `ci`, `deps`

Breaking changes use `!` or a footer:

```text
feat(resource)!: replace Hono thunks

BREAKING CHANGE: Resources now use stable operation IDs and typed inputs.
```

Conventional Commits describe git history. Changesets independently describe package release impact. A consumer-visible change normally needs both an appropriate commit and a `.changeset/*.md` entry.

### Commit template

The repository and generated starter contain `.gitmessage`. Enable it for this checkout:

```bash
git config commit.template angular/.gitmessage
```

## Automated testing standard

- Framework: Vitest for unit and integration tests.
- Tests are colocated with source.
- New or substantively rewritten tests use `FileName.test.ts`.
- Existing `*.spec.ts` remains supported until an isolated mechanical migration.
- Each test verifies one behavior and has a descriptive expected-outcome name.
- External APIs, providers, databases, clocks, IDs, and filesystems are deterministic fakes or local fixtures.
- Test state, timers, injectors, streams, sockets, XHR, and DOM changes are cleaned up.
- AI-generated tests are expected, but engineers review whether assertions are correct, sensitive to regression, and cover errors/edge cases.

Coverage must remain at least 80% for statements, branches, functions, and lines. Changed source files must independently meet 80% in applicable metrics. A high line score cannot compensate for branch coverage below the minimum.

Required tests may not skip because a sibling checkout, live service, or optional local dependency is missing. Non-required provider/platform skips require an inline reason, owner, and removal condition.

Run the standard commands:

```bash
pnpm type-check
pnpm lint
pnpm format:check
pnpm test
pnpm test:coverage
pnpm build
```

The repository uses pnpm with a frozen lockfile. Consumers may use another package manager;
do not make pnpm a runtime dependency.

## Pull requests

Use `.github/PULL_REQUEST_TEMPLATE.md`. A PR must state:

- user/consumer outcome;
- affected rearchitecture phase/checkpoint when applicable;
- public API and compatibility impact;
- test commands, coverage, skips, package/bundle evidence;
- security/SSR/transport considerations;
- rollout and rollback plan; and
- Changeset decision.

Do not combine unrelated behavior, mass formatting, lockfile regeneration, generated documentation, and client migrations in one review. Tests normally live in the same `feat`/`fix` commit as the behavior; use `test` only when tests are the sole change.

## Review expectations

Reviewers should verify that:

- the change fixes the contract rather than adding another application workaround;
- types match runtime behavior without broad casts;
- errors, cancellation, cleanup, concurrency, and retries are explicit;
- Angular and SSR conventions in `AGENTS.md` remain satisfied;
- no token, cookie, provider error, or sensitive value reaches logs/snapshots;
- packed/public consumers are tested when a package boundary changes; and
- documentation and agent instructions do not claim enforcement that tests cannot demonstrate.

## Repository scope

Keep this repository specific to the framework. Application code, client
inventories, production schemas, deployment receipts, and private migration plans
belong in their application repositories. Use synthetic, framework-owned fixtures
for regression and conformance tests; do not copy a client's contract or source.

## License

This project uses Apache-2.0. Contributions intentionally submitted for inclusion
are provided under that license unless explicitly stated otherwise; contributors
retain their copyright. See [LICENSE](LICENSE).
