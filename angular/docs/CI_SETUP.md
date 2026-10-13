# CI and local quality gates

## Framework repository

The full local gate is:

```bash
pnpm run ci
```

It runs version synchronization, strict TypeScript/type-negative programs, ESLint and
Biome/import checks, document formatting, all package builds, Vitest, required offline
packed conformance, bundle enforcement, and Knip.

Focused commands:

```bash
pnpm type-check
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm test:coverage
pnpm test:packed-conformance
pnpm test:browser-conformance
pnpm measure-bundle:enforce
pnpm knip
```

Install Chromium once for local browser conformance:

```bash
pnpm exec playwright install chromium
```

The real cross-repository suite is deliberately separate and requires an artifact manifest:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

It may not fall back to a sibling checkout or skip when artifacts are absent.

## Coverage

Vitest enforces at least 80% statements, branches, functions, and lines. Changed source
files are expected to meet the same threshold. Tests are deterministic, colocated, and
normally land with behavior. Live production/Firebase services are not PR gates.

## GitHub Actions

Maintainer tooling uses Node 24 LTS. The `.nvmrc` and `.node-version` files pin 24.21.0.
Workflows install pnpm 10.34.6 with npm into a temporary runner directory and run a frozen install.
The matrix retains Node 20 for the published library contract and Node 22 for compatibility.
The primary Node 24 build produces the exact package artifact consumed by a
separate Chromium conformance job. Release jobs use Changesets and never publish from an
arbitrary feature branch.

Generated applications receive their own frozen-pnpm CI, coverage, build, security, and
Playwright workflows. Commit the generated `pnpm-lock.yaml` before enabling those jobs.

## Package evidence

The packed harness creates clean temporary consumers from tarballs, checks export targets
and checksums, scans emitted JavaScript/declarations for forbidden server dependencies,
compiles positive/negative programs, and exercises runtime success/failure/cancellation.
The browser harness independently repacks the downloaded build, compiles its public imports,
and exercises cross-origin XHR, binary fetch, streaming fetch, and WebSockets without a
sibling source link or live service.

The joint manifest additionally identifies ShipAPI contract/client/fixture artifacts and
their deterministic graph hash. Source links are not release evidence.

## Pull request evidence

Record exact commands, test/coverage totals, skipped tests, package scan, bundle changes,
SSR/security implications, rollout, rollback, and Changeset decision in the PR template.
Use Conventional Commits for commits and PR titles.

## Tooling runtime

Use `nvm install` and `nvm use` from the repository root before installing dependencies.
The maintainer pin does not raise the published package's `engines.node >=20` contract.
The Node 20 check builds and checks the library with Node 24 maintainer tooling, then
switches to Node 20 for physical published-package types, runtime, and CLI verification.
The isolated lowest-peer consumer uses Angular 20.0.0 and TypeScript 5.8.3 to check
public declarations and invalid Query inputs under the maintainer runtime.
Its published CLI and request-owned SSR stability checks run with an explicit Node 20
binary. The receipt records both runtime versions. The optional ShipContract package
retains its own Node 22 minimum; it is installed as a physical type-only fixture here,
not claimed to support Node 20 runtime execution.
It does not run new maintainer-only tools under Node 20. Node 22 and Node 24 retain full
framework coverage and also build the documentation.
Node 24 owns packed artifacts, Chromium, security, scaffold, eval, and release jobs.
Newly generated applications default to Node 24 in their setup and CI workflows.

[Angular 20 supports Node 24](https://angular.dev/reference/versions).
[Node 24 is an LTS line](https://nodejs.org/en/about/previous-releases).
The upgraded [setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0),
[checkout](https://github.com/actions/checkout/releases/tag/v7.0.1),
[upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2),
[download-artifact](https://github.com/actions/download-artifact/releases/tag/v8.0.2)
actions use the Node 24 action runtime. GitHub-hosted `ubuntu-latest` runners support it.
A self-hosted deployment of these workflows needs Actions Runner 2.327.1 or newer.
Action runtime selection is separate from the Node 20/22 compatibility task runtime.

The pnpm setup step installs the pinned package directly. It does not use an older
bootstrap package or switch from pnpm 11 to pnpm 10. It adds the temporary package
binary directory to the task path and leaves the user's home directory unchanged.

Release jobs disable package-manager caching. Registry credentials remain scoped to
steps that install or publish packages. The required audit and CI Summary gates remain active.
A new Node 24 CI run is required before claiming the toolchain upgrade passes.

The starter's App Engine cleanup now uses the maintained Google Cloud CLI setup action.
It preserves the [previous cleanup policy](https://github.com/Reviewable/appengine-remove-action/blob/v2.1.2/src/main.ts):
select zero-traffic versions, sort by deployment time, and retain the newest three
in the default service. It uses the selected deployment project. No age or additional
service or serving-version deletion policy is introduced. This change prepares the
generated workflow; validation does not deploy or delete cloud resources.
