# ShipAPI

ShipAPI is a TypeScript application kernel for defining operations once and
projecting them onto runtime and tooling adapters.

The operation kernel and focused adapters are maintained on `dev`; stable releases
come from `main`. `@sixthsummit/ship-api` retains the route-first v4 compatibility
surface for incremental migrations. Package release status and application
production rollout are separate decisions. See [package changelogs](CHANGELOG.md)
for released versions and `.changeset/` for pending changes.

## Architecture

```text
typed operation declarations
        ↓
validated application graph
        ├── direct execution
        ├── Hono HTTP routes
        ├── client-safe contract
        ├── OpenAPI
        ├── route migration accounting
        └── deterministic diagnostics and impact queries
```

An operation declares its stable ID, input and status-indexed output schemas,
errors, access, transaction mode, dependencies, effects, and optional transport.
The graph is executable. It rejects missing providers, hidden effects, unsafe
transactions, duplicate routes, invalid schemas, and boundary violations without
depending on an agent prompt or framework-specific base class.

## Packages

| Package | Responsibility |
| --- | --- |
| `@sixthsummit/ship-core` | Operations, modules, graph, execution, access, dependencies, effects, and capabilities |
| `@sixthsummit/ship-hono` | HTTP declarations, bounded bodies, credentials, and Hono projection |
| `@sixthsummit/ship-drizzle` | Transaction-scoped capabilities and explicit repository primitives |
| `@sixthsummit/ship-contract` | Browser-safe structural client, manifest, codecs, and OpenAPI projection |
| `@sixthsummit/ship-auth-firebase` | Optional Firebase credential and actor adapter |
| `@sixthsummit/ship-cache-redis` | Optional Redis backend for declared read caching |
| `@sixthsummit/ship-jobs-bullmq` | Optional BullMQ jobs backend |
| `@sixthsummit/ship-realtime-socketio` | Socket.IO + Redis realtime gateway |
| `@sixthsummit/ship-webhooks` | Provider webhook signature verifiers |
| `@sixthsummit/ship-observability-otel` | Optional OpenTelemetry integration |
| `@sixthsummit/ship-testing` | Parity fixtures and disposable PostgreSQL support |
| `@sixthsummit/ship-cli` | Graph checks, inspection, impact, contract emission, and route migration |
| `@sixthsummit/ship-api` | Current v4 compatibility APIs and legacy scaffold tooling |

Core has no HTTP, ORM, auth-provider, logger, or telemetry dependency. Adapters
can be selected without pulling their trust zones into every application.

## Small application

```ts
import {
  defineApp,
  defineModule,
  defineOperation,
  publicAccess,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";
import { z } from "zod";

const health = defineOperation({
  id: "system.health",
  transport: http.get("/health"),
  input: {},
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async () => ({ ok: true as const }),
});

const system = defineModule({
  id: "system",
  operations: [health],
  providers: [],
  imports: [],
  exports: [],
});

export const app = defineApp({ id: "example", modules: [system] });
export const server = createHonoAdapter(app);
```

The direct executor tests the same operation without HTTP. The contract and CLI
project from `app`; no second route/schema registry is maintained.

Production-shaped examples live in
[`fixtures/consumers/minimal`](fixtures/consumers/minimal) and
[`fixtures/consumers/customized`](fixtures/consumers/customized). Their runner
installs physical package archives outside this workspace before compiling,
testing, and booting them.

## Installation

Use Node.js 22.22 or newer and the pnpm version pinned in `package.json`.
Packages currently use GitHub Packages; making the source public does not change
the registry. Configure `@sixthsummit:registry=https://npm.pkg.github.com` and
provide a read token through your user-level npm configuration when required.
Never commit the token. Pin exact released versions for deployed applications.

## Verification

```sh
corepack enable
pnpm install --frozen-lockfile

pnpm run verify:fast
pnpm run verify
```

`verify` runs Biome and architecture rules, every workspace type check/build,
the full Vitest and coverage suites, real PostgreSQL integration tests, legacy
parity, edge bundling, packed-package installation, both golden consumers, docs,
and the isolated runtime dependency audit.

Useful focused commands:

```sh
pnpm run check
pnpm run type-check
pnpm test
pnpm run test:coverage
pnpm run test:integration
pnpm run test:parity
pnpm run test:edge
pnpm run test:pack
pnpm run test:consumer:minimal
pnpm run test:consumer:customized
pnpm run docs:build
pnpm run audit:runtime
```

## Documentation and release status

- [Quick start](docs/v4/quick-start.md)
- [Public API surface](docs/PUBLIC_API_SURFACE.md)
- [Architecture decisions](docs/rearchitecture/decisions/README.md)
- [Implementation status and dated evidence](docs/V4_STATUS.md)
- [Package changelogs](CHANGELOG.md)
- [Versioning](docs/VERSIONING.md) and [release process](docs/RELEASING.md)

Dated architecture and consumer evidence records describe the commits tested at
that time. They are not a claim that the current checkout passed those checks or
that an application is approved for production.

## Compatibility

Current applications may continue using `@sixthsummit/ship-api`, `createApp`,
route-first Hono composition, `hc<typeof app>`, `DrizzleEntityService`, legacy
jobs/cache/storage, and the existing scaffold during the v4 migration window.
Those APIs are supported compatibility surfaces, not the model for new kernel
work. They cannot leak into focused packages or become a second graph.

## Repository layout

```text
packages/
  kernel/              @sixthsummit/ship-core
  hono/                @sixthsummit/ship-hono
  drizzle/             @sixthsummit/ship-drizzle
  contract/            @sixthsummit/ship-contract
  auth-firebase/       Firebase adapter
  cache-redis/         Redis cache backend adapter
  jobs-bullmq/         BullMQ jobs backend
  realtime-socketio/   Socket.IO + Redis gateway
  webhooks/           provider webhook verifiers
  observability-otel/  OpenTelemetry adapter
  testing/             development-only fixtures
  cli/                 graph and contract tooling
  core/                @sixthsummit/ship-api compatibility distribution
fixtures/consumers/    packed minimal and customized consumers
docs/rearchitecture/   RFC execution records, ADRs, gates, and changelog
apps/docs/             generated Starlight documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changing
the repository. Conventional Commits communicate intent; Changesets alone owns
package versions and changelogs.

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
