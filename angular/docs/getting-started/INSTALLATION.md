# Installation

Stable versions are released from `main`; `dev` produces alpha snapshots. Framework
development uses pnpm; consumers may use another package manager. Packages use
public npmjs releases under `@sixthsummit`; no read token is needed. Use `latest` for
stable releases or explicitly select `alpha` for development snapshots. See the root
`RELEASE_GUIDE.md` for the release process.

## Framework checkout

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm run ci
```

Do not link a sibling ShipAPI source checkout into this workspace. Local integration uses
packed artifacts and an explicit manifest:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

## Create a local smoke application

Build first, then run the CLI directly:

```bash
pnpm build
node ../packages/angular/cli/ship-angular.js create smoke-app --skip-install --skip-git
cd smoke-app
pnpm install
pnpm run ci
```

Use an explicit tarball install for realistic prerelease/client verification. Never use a
source link as release evidence.

## Existing Angular application

Install an exact released version and run Angular's
schematic:

```bash
pnpm add @sixthsummit/ship-angular@<exact-version>
pnpm exec ng add @sixthsummit/ship-angular --skip-install
```

Then generate the app-owned ShipAPI client boundary using the packed contract package:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract
```

Existing Hono clients migrate through `/hono-v4`; new code uses `/operations`. Follow the
[operation guide](../architecture/OPERATION_CLIENT_GUIDE.md) and
[migration playbook](../architecture/CLIENT_MIGRATION_PLAYBOOK.md).

## Requirements

- Maintainer checkout: Node 24 LTS, pinned by `.nvmrc` and `.node-version`
- Published library: Node.js 20 or newer; CI retains Node 20 and Node 22 compatibility checks
- Angular 20
- browser-safe ShipAPI contract/client artifacts for ShipAPI integration
- Firebase packages only when the selected auth adapter needs them
