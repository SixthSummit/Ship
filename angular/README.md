# ShipAngular

ShipAngular is the frontend-only Angular half of the Sixth Summit stack. It pairs with
ShipAPI while keeping a separate package boundary and release cadence. The framework is
maintained on `dev`, with stable releases from `main`. The operation-client architecture
is implemented; pending changes are tracked by Changesets.

ShipAngular is an Angular 20 framework that is safe for both engineers and coding agents:
strict types, explicit browser/SSR boundaries, deterministic generators, lossless errors,
and automated package conformance.

## Architecture

- standalone, OnPush Angular components with signal-first public APIs and `inject()` DI;
- structural ShipAPI operation clients keyed by stable operation IDs;
- generated, packed, browser-safe contract/client artifacts—never server route-tree types;
- declared API failures as values with status, details, headers, and request IDs retained;
- one operation-aware auth/request-policy pipeline for browser and request-scoped SSR;
- explicit upload, download, stream, and socket capabilities;
- client-safe typed forms with no Drizzle/server imports;
- separate generic REST support for third-party APIs;
- temporary Hono v4 and pre-Hono URL-client compatibility isolated under named entrypoints.

The historical Hono-primary decision is retained in
[`docs/architecture/CONTRACT.md`](docs/architecture/CONTRACT.md) and superseded by
[`ADR 0002`](docs/architecture/decisions/0002-operation-client-contract.md).

## Package entrypoints

| Entrypoint                  | Responsibility                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| `@sixthsummit/ship-angular` | legacy/general Angular, auth adapter, REST, online, env, pipes          |
| `/operations`               | client/result types, DI, resources, mutations, policy, SSR context      |
| `/ship-api`                 | import-free adapter for ShipAPI's structural browser client             |
| `/auth`                     | operation-backed session adapter                                        |
| `/firebase-auth`            | optional Firebase frontend adapter                                      |
| `/query`                    | optional TanStack Query reads, mutations, cache keys, and SSR hydration |
| `/realtime`                 | manifest-declared realtime subscriptions and presence                   |
| `/forms`                    | operation input forms and browser-safe codecs                           |
| `/upload`, `/download`      | progress-aware upload and exact-byte download                           |
| `/stream`, `/socket`        | typed SSE/chunked streams and bounded WebSockets                        |
| `/testing`                  | auth and operation-client conformance helpers                           |
| `/hono-v4`                  | temporary application-owned compatibility mapping                       |
| `/legacy-rest`              | temporary URL-client migration mapping for pre-Hono applications        |

The `/query` entrypoint is pending release on `dev`; it is not included in the
previously released 4.1.0 package. See queued Changesets for release intent.

## Repository

```text
../packages/angular/               published library, entrypoints, CLI, schematics, template
../apps/angular-docs/                   generated documentation site
conformance/                 independently packed contract/client fixtures and consumers
docs/architecture/           ADRs, phase records, gates, and migration ledger
scripts/                     build, package, bundle, and conformance automation
```

Application features are generated into `src/app/modules`; the framework no longer ships
a source-copy feature catalog.

## Installation

Use Angular 20 and an exact framework version from [the package changelog](../packages/angular/CHANGELOG.md).
Packages currently use GitHub Packages. Configure
`@sixthsummit:registry=https://npm.pkg.github.com` and provide any required read token
in your user-level npm configuration, never in the repository.
See [installation](docs/getting-started/INSTALLATION.md) and the
[query guide](docs/guides/TANSTACK_QUERY.md) for optional TanStack Query setup.

## Development

Use the Node version in `.nvmrc` and the pnpm version in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run ci
```

Useful focused gates:

```bash
pnpm type-check
pnpm lint
pnpm test:coverage
pnpm build
pnpm test:packed-conformance
pnpm test:browser-conformance
pnpm measure-bundle:enforce
pnpm knip
```

The browser gate packs the current build, type-checks a clean public consumer, and runs
cross-origin upload, download, stream, and socket fixtures in Chromium. Install its local
browser once with `pnpm exec playwright install chromium`.

The real cross-repository gate intentionally requires ShipAPI's explicit artifact manifest:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

Start with [`AGENTS.md`](AGENTS.md), the
[`rearchitecture program`](docs/architecture/REARCHITECTURE_PROGRAM.md), and the
[`testing gates`](docs/architecture/TESTING_GATES.md). Contributions use Conventional
Commits and the templates under `.github/`.

## Status and releases

ShipAngular uses the root [Ship release workflow](../RELEASE_GUIDE.md) with independent package versions. Publishing is initially disabled and manually dispatched; `dev` is preparation and alpha, while `main` owns stable releases.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
