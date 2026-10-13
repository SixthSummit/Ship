# ShipAPI automation

ShipAPI uses pnpm workspaces and one root `pnpm-lock.yaml`. `package.json#packageManager` pins the pnpm version. Repository workflows call the local composite setup action in `.github/actions/setup-node-pnpm/action.yml`, then install with `pnpm install --frozen-lockfile`.

## Workflows

### CI (`ci.yml`)

Runs for pushes and pull requests targeting `main` or `dev`.

Required behavior gates:

- no Changesets pre mode (`.changeset/pre.json` must not exist);
- Biome formatting, imports, and high-signal lint rules;
- focused ESLint architecture invariants that Biome cannot express directly;
- workspace publication consistency;
- TypeScript;
- package builds;
- unit tests and coverage;
- real-Postgres integration tests;
- edge-runtime bundling;
- documentation build;
- convention/skill sync;
- published-runtime dependency audit.

`CI Summary` depends on these jobs and fails when a required job fails. Database migration checks are currently skipped because framework migrations live in generated consumer applications.

### Security (`security.yml`)

Runs nightly and on demand. It treats dependency zones differently:

- the isolated `packages/core` production graph is a hard gate;
- the docs application and complete build/test graph are maintenance signals;
- runtime failures notify `SLACK_SECURITY_WEBHOOK_URL` when that repository secret is configured.

No license job exists until the company defines an enforceable allow/deny policy.

### Dependency updates (`dependency-update.yml`)

Runs a weekly outdated report and audit remediation. Residual findings do not prevent the remediation PR from being opened; the runtime gate makes the merge decision. A manual run can update versions allowed by current manifest ranges.

### Release (`release.yml`)

Changesets owns package versions, changelogs, publication, GitHub releases, and package tags. Conventional Commit prefixes communicate intent but do not compute versions. Both release lines trust the CI run on the exact commit instead of re-running the suite: on `dev`, the CI workflow completing (`workflow_run`) publishes a snapshot prerelease of every package with a pending changeset under the `alpha` dist-tag, with no commit or PR; on `main`, a push waits for that commit's CI run to succeed, then `changesets/action` opens the version PR or publishes stable versions to `latest`. Publish-permissioned jobs deliberately avoid a dependency cache because they hold publish credentials.

## Local commands

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm run type-check
pnpm run check
pnpm run test
pnpm run test:coverage
pnpm run test:integration
pnpm run test:parity
pnpm run test:edge
pnpm run test:pack
pnpm run build
pnpm run docs:build
pnpm run audit:runtime
pnpm run verify:fast
pnpm run verify
pnpm run ci
```

The fast default suite is Docker-free. Run the integration gate when database, storage, transaction, migration, or infrastructure behavior changes. Run parity and packaging gates when a runtime or public contract changes.

## Configuration

- `pnpm-workspace.yaml`: workspace membership and shared-lockfile policy.
- `pnpm-lock.yaml`: the only dependency lockfile.
- `.audit-ci.runtime.json`: hard-gate policy for an isolated deployable production graph.
- `.audit-ci.json`: full-workspace maintenance policy.
- `.github/pull_request_template.md`: evidence required from each change.
- `.gitmessage`: Conventional Commit authoring template.

## Dependency failures

Classify an advisory before changing policy:

1. published runtime;
2. optional runtime adapter;
3. build/test tooling;
4. documentation application.

Do not add a path-shaped allowlist entry merely to turn CI green. Fix or upgrade runtime exposure first. Keep non-runtime findings visible in their maintenance scan without allowing them to misrepresent framework correctness.
