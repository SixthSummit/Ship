# Operation application structure

The focused scaffold is intentionally small. Its layout communicates ownership
and executable boundaries without generated layers that only rename each other.

```text
my-api/
├── src/
│   ├── application.ts
│   ├── application.test.ts
│   ├── application.integration.test.ts
│   ├── server.ts
│   └── modules/
│       └── system/
│           ├── health.operation.ts
│           └── module.ts
├── ship.config.ts
├── biome.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── vitest.integration.config.ts
├── AGENTS.md
├── .gitmessage
├── .github/pull_request_template.md
└── package.json
```

## `*.operation.ts` owns behavior

An operation is the smallest public unit. Keep its stable ID, schemas, statuses,
declared failures, access, transaction mode, dependencies, effects, transport,
and handler together. Splitting those facts across a controller decorator,
service base class, route registry, and generated DTO is precisely the drift the
replacement architecture removes.

Operations may call domain functions from adjacent files. Domain behavior should
not import Hono, a database client, Firebase, OpenTelemetry, or process-global
state. Those systems enter through declared capabilities and adapter providers.

Tests are colocated:

- `FileName.test.ts` checks the operation directly through `createExecutor()`;
- `FileName.integration.test.ts` checks a real adapter or approved disposable
  infrastructure; and
- one test verifies one meaningful behavior or failure mode.

## `module.ts` owns a bounded feature

`defineModule()` groups operations and providers, declares module imports and
exports, and gives the compiler an ownership boundary. It is not a dependency
injection container hidden behind decorators. The compiler rejects duplicate
IDs, missing providers, illegal imports, provider cycles, effect violations, and
transport collisions deterministically.

Use one module for a cohesive capability. Do not create a module for every table
or mechanically reproduce controller/service/repository folders when the code has
no distinct responsibility.

## `application.ts` is the composition root

`defineApp()` compiles the module set into an immutable application graph. The
composition root selects concrete providers and adapters; operation files depend
only on their declared tokens.

Nothing should register routes or mutate a global container at import time. If
the graph cannot describe a dependency or effect, the architecture is missing a
primitive and should fail visibly.

## `ship.config.ts` exposes tooling

The file contains one named `app` export:

```ts
export { app } from "./src/application.js";
```

`ship-api check`, `inspect`, `affected`, and `contract` load this exact graph.
There is no hand-maintained tooling registry.

## `server.ts` owns process startup

The generated server creates the Hono adapter and starts Node's listener. Keep
port and environment validation at the process boundary. Business modules must
not import the listener.

If OpenTelemetry is installed, start it before dynamically importing the server
graph so ESM does not evaluate HTTP/database modules before instrumentation.

## Toolchain files are enforcement

- `biome.json` owns formatting and linting.
- `tsconfig.json` uses strict TypeScript and
  `exactOptionalPropertyTypes`.
- `vitest.config.ts` enforces 80% for statements, branches, functions, and lines.
- `AGENTS.md` points agents to graph inspection and the same commands humans run.
- `.gitmessage` and the PR template encode the company contribution guide.

The generated `pnpm run verify` command is the local and CI boundary. Prompts,
IDE plugins, and MCP tools may improve ergonomics but are never correctness
dependencies.

## Add infrastructure only when required

A data-backed feature normally adds:

```text
src/modules/notes/
├── create-note.operation.ts
├── read-note.operation.ts
├── module.ts
├── repository.ts
├── schema.ts
├── create-note.operation.test.ts
└── notes.integration.test.ts
```

The repository exposes a narrow capability, the Drizzle adapter provides it
inside the declared unit of work, and the integration test uses disposable
PostgreSQL. Authentication and external effects follow the same dependency
pattern.

## Compatibility applications

Existing v4 alpha applications can retain the monolithic
`@sixthsummit/ship-api` layout, route-first Hono modules,
`DrizzleEntityService`, generated `module.json`, and `hc<typeof app>()` during
incremental migration. That layout is a supported compatibility tier, not the
canonical structure for new operation-native services.
