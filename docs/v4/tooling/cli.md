# CLI reference

`ship-api` is the framework's command-line tool. New application-graph tooling
is published by the focused `@sixthsummit/ship-cli` package. The monolithic
`@sixthsummit/ship-api` package retains the same commands for compatibility and
continues to own legacy scaffolding, migration, and local-stack commands.

Install the focused CLI as a development dependency in operation-based apps:

```sh
pnpm add -D @sixthsummit/ship-cli
```

## `create` — operation-native application

```sh
pnpm dlx "@sixthsummit/ship-cli@<exact-version>" create my-api --skip-install
```

The focused command creates one minimal, tested application shape. It writes a
public health operation, Hono projection, direct and HTTP tests, strict
TypeScript, Biome, 80% coverage thresholds, graph/contract scripts,
`AGENTS.md`, `.gitmessage`, and a pull-request template. It installs with pnpm
unless `--skip-install` is present.

The build-generated release manifest pins `@sixthsummit/ship-core`,
`@sixthsummit/ship-hono`, `@sixthsummit/ship-contract`, and the CLI to the exact
versions reviewed together. The pack gate rejects a stale manifest, creates the
app from physical archives outside the workspace, and runs its complete
`pnpm run verify` command.

Names must be lower-case kebab-case. Existing targets are never overwritten.
`create . --current-dir` is accepted only in an empty directory. The focused
command does not initialize or commit Git state.

This page documents focused graph commands first and then the monolithic
compatibility commands.

## Application graph commands

The graph commands load `ship.config.ts`, which must export the compiled application as a named `app` export. They operate on the same immutable graph that drives runtime execution; there is no separate route manifest to keep synchronized.

```ts
// ship.config.ts
import { defineApp } from "@sixthsummit/ship-core";
import { accountsModule } from "./src/accounts/module.js";

export const app = defineApp({ id: "example-api", modules: [accountsModule] });
```

### `check` — compile and validate

```sh
ship-api check [--app ship.config.ts] [--format human|json] [--emit [path]]
```

`check` imports the TypeScript application declaration, runs the kernel compiler, and reports every graph diagnostic. `--format json` is stable machine-readable output for CI, editors, and agents. `--emit` writes the deterministic graph to `.ship/graph.json`; pass a path after the flag to choose another destination.

Exit `0` means the graph compiled, exit `1` means the application compiler rejected it, and exit `2` means the CLI could not load or query the application. Diagnostics retain stable `SHIP_*` codes and remediation hints in both output formats.

### `inspect` — read one graph node

```sh
ship-api inspect app [id] [--format json]
ship-api inspect module <id> [--format json]
ship-api inspect operation <id> [--format json]
ship-api inspect provider <id> [--format json]
```

Inspection reports ownership, dependencies, access, transaction mode, transport binding, and declared failures as applicable. This is the bounded-context entry point for understanding an unfamiliar operation without reading the whole repository.

### `affected` — project downstream impact

```sh
ship-api affected module <id> [--format json]
ship-api affected operation <id> [--format json]
ship-api affected provider <id> [--format json]
```

For a module, the command follows reverse module imports. For a provider, it follows reverse provider dependencies and then the operations that consume them. Results are sorted lists of affected modules, operations, and providers, suitable for focused tests and review scoping.

### `contract` — emit client and OpenAPI artifacts

```sh
ship-api contract \
  [--app ship.config.ts] \
  [--out .ship/contract.json] \
  [--openapi .ship/openapi.json] \
  [--openapi-title "My API"] \
  [--api-version 1.0.0] \
  [--format human|json]
```

Both artifacts derive from the same compiled operation graph and carry the
same deterministic fingerprint. The command writes each file atomically and
fails before writing if the output paths collide. ShipAngular and other clients
consume the client-safe manifest; API documentation and external integrations
consume the OpenAPI 3.1 projection.

The `check`, `inspect`, `affected`, and `contract` implementations are also
available programmatically from `@sixthsummit/ship-cli`. Structured diagnostics
and exit classes are part of that package's typed surface.

## Compatibility commands

The remaining commands in this section belong to `@sixthsummit/ship-api`. They
remain supported for existing route-first v4 applications, but they do not
generate or mutate the operation graph.

### Legacy `create`

```sh
npx @sixthsummit/ship-api create <project-name> [options]
```

Copies a template into a new directory, processes placeholders, pins the framework version into `package.json`, runs `npm install`, and `git init`s.

**Arguments:**

| Argument | Required | Description |
| --- | --- | --- |
| `<project-name>` | yes | Directory name to create. Use `.` with `--current-dir` to scaffold into the current directory. |

**Options:**

| Flag | Default | Description |
| --- | --- | --- |
| `-t, --template <name>` | `"default"` | Template to scaffold from. Use `v4` for the modern template. |
| `-d, --database <type>` | `"postgres"` | Database type — currently cosmetic. |
| `--current-dir` | `false` | Install in the current working directory instead of creating a new one. |
| `--skip-install` | `false` | Skip `npm install` after copying files. |
| `--skip-git` | `false` | Skip `git init` and the initial commit. |

**What it does:**

1. Resolves the template path (`templates/<name>/` inside the framework package).
2. Copies the template tree, processing `{{PROJECT_NAME}}`, `{{PROJECT_ROOT}}`, and other placeholders.
3. Pins the current framework version into the new `package.json`. For prereleases (e.g. `4.0.0-beta.1`), uses a caret range. For stable releases, fetches the latest from npm via `npm view`.
4. Renames `_gitignore` → `.gitignore` (templates ship the file under an underscored name to avoid npm publishing rules).
5. Runs `npm install` (skipped with `--skip-install`).
6. Runs `git init` + initial commit (skipped with `--skip-git`).

Examples:

```sh
# Modern v4 template
npx @sixthsummit/ship-api create my-app --template default

# Scaffold into the current directory (CWD must be empty)
npx @sixthsummit/ship-api create . --current-dir --template default

# Scaffold without installing — useful for review-then-install workflows
npx @sixthsummit/ship-api create my-app --template default --skip-install
```

### `dev` — local development orchestrator

```sh
ship-api dev [options]
```

Brings up `docker-compose` dependencies, spawns `npm run dev`, and polls `/livez` until the app is healthy.

**Options:**

| Flag | Default | Description |
| --- | --- | --- |
| `--bare` | `false` | Skip Docker Compose entirely. Use when you've already started Postgres / Redis externally. |
| `--reset` | `false` | Run `docker compose down -v` before starting (deletes volumes — wipes the database). |
| `-p, --port <port>` | `$PORT` or `3000` | Port to poll for health. |

**What it does:**

1. Looks for `docker-compose.yml` or `compose.yaml` in the cwd.
2. Cheap-parses the file (regex, no deps) to detect which dependency services are declared. Recognized: `postgres`, `redis`, `jaeger`, `otel-collector` (legacy). Other services are ignored.
3. Runs `docker compose up -d <detected services>`.
4. Spawns `npm run dev` (or `npm run local` if `dev` doesn't exist) inheriting stdio.
5. Polls `/livez` → `/healthz` → `/health-check` → `/` every 500ms until one returns non-5xx, or 60s timeout. The first endpoint that responds is treated as healthy.
6. Stays attached to the npm child until SIGINT or SIGTERM, then forwards the signal.

The compose containers stay running on exit — subsequent `ship-api dev` reuses them, which makes hot-reload fast.

Examples:

```sh
# Default: bring up compose deps, run npm run dev, wait for /livez
ship-api dev

# External Postgres / Redis (e.g. you ran a local docker by hand)
ship-api dev --bare

# Wipe state and start fresh
ship-api dev --reset
```

### `generate` (alias `g`) — code generators

```sh
ship-api g <type> <name> [options]
ship-api generate <type> <name> [options]
```

Eight generator types, each scaffolding canonical-shape code into the right place.

#### `g module <name>`

Scaffolds a complete v4 module at `src/modules/<name>/`. Full seven-file shape: `schema.ts`, `permissions.ts`, `validation/schemas.ts`, `services/<Name>Service.ts`, `routes.ts`, `index.ts`, `module.json`.

| Flag | Description |
| --- | --- |
| `--force` | Overwrite an existing module directory. |

The name accepts any input case (`accounts`, `Account`, `user-tokens`, `userToken`) and emits canonical kebab-case-plural for paths plus PascalCase / camelCase / SCREAMING_SNAKE variants for code via these placeholders: `{{namePlural}}`, `{{nameSingular}}`, `{{namePascalPlural}}`, `{{namePascalSingular}}`, `{{nameCamelPlural}}`, `{{nameCamelSingular}}`, `{{NAME_PLURAL}}`, `{{NAME_SINGULAR}}`.

After scaffolding, the generator prints next steps: add the schema to `createApp({ schema: ... })`, register the routes in `src/index.ts`, run `npm run db:generate`.

#### `g resource <name> --fields "..."`

Same module scaffold as `g module`, but the schema and validation are customized from the `--fields` spec.

| Flag | Required | Description |
| --- | --- | --- |
| `--fields <spec>` | yes | Comma-separated `name:type[?]` pairs. `?` marks nullable. |
| `--force` | no | Overwrite existing. |

Supported types:

| Type | Drizzle column | Zod |
| --- | --- | --- |
| `string` | `varchar({ length: 255 })` | `z.string()` |
| `text` | `text()` | `z.string()` |
| `integer` | `integer()` | `z.number().int()` |
| `bigint` | `bigint({ mode: "number" })` | `z.number().int()` |
| `boolean` | `boolean()` | `z.boolean()` |
| `timestamp` | `timestamp({ withTimezone: true })` | `z.coerce.date()` |
| `uuid` | `uuid()` | `z.string().uuid()` |
| `json` | `jsonb()` | `z.unknown()` |

Unknown types emit `text()` with a `// TODO[ship-api]:` marker.

Example:

```sh
ship-api g resource posts --fields "title:string,body:text,published:boolean,publishedAt:timestamp?,metadata:json?"
```

This produces:

- `schema.ts` with `posts` table, baseFields, types
- `permissions.ts` with `posts:read`, `posts:create`, `posts:update`, `posts:delete`
- `validation/schemas.ts` with `createPostSchema`, `updatePostSchema`, `listPostsQuerySchema` — `?`-suffixed fields are `.optional()`
- `services/PostService.ts` extending `DrizzleEntityService<typeof posts>`
- `routes.ts` with full CRUD chain
- `index.ts` re-exporting everything

#### `g service <name> --module <module>`

Adds `<NameSingular>Service.ts` to an existing module's `services/` directory. Use when you need a second service in a module (e.g. `PostService` and `PostDraftService` both inside `posts`).

| Flag | Required | Description |
| --- | --- | --- |
| `--module <name>` | yes | Existing module to add the service to. |
| `--force` | no | Overwrite. |

The generated service extends `DrizzleEntityService<typeof <table>>` against the module's primary table by default; rewire it to a different table if appropriate.

#### `g schema <name> --module <module>`

Adds a Drizzle `pgTable` at `<module>/schemas/<name>.ts`. Useful when a module has more than one table (e.g. `posts` plus `post_revisions`).

| Flag | Required | Description |
| --- | --- | --- |
| `--module <name>` | yes | Existing module. |
| `--force` | no | Overwrite. |

The template ships a minimal table — `id` UUID PK plus `...baseFields`. Customize in place; run `npm run db:generate` after.

#### `g middleware <name>`

Scaffolds `src/middleware/<name>.ts` — a Hono middleware factory typed against `AppEnv`.

| Flag | Description |
| --- | --- |
| `--force` | Overwrite. |

Generated shape:

```ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@sixthsummit/ship-api";

export interface <Name>Options { /* ... */ }

export const <name> = (opts?: <Name>Options): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    // before
    await next();
    // after
  };
```

#### `g job <name> --module <module>`

Adds a BullMQ job stub at `<module>/jobs/<name>.job.ts`. The framework's `InitJobs` bootstrapper auto-discovers job files at boot.

| Flag | Required | Description |
| --- | --- | --- |
| `--module <name>` | yes | Module to add the job to. |
| `--force` | no | Overwrite. |

Generated shape (uses `defineJob` from the framework):

```ts
import { defineJob } from "@sixthsummit/ship-api";
import { z } from "zod";

const <Name>Payload = z.object({ /* ... */ });

export const <name>Job = defineJob({
  name: "<module>.<name>",
  payload: <Name>Payload,
  async process(payload, ctx) {
    // ...
  },
});
```

#### `g cron <name> --module <module>`

Adds a cron repeatable at `<module>/cron/<name>.cron.ts`. Same auto-discovery as jobs.

| Flag | Required | Description |
| --- | --- | --- |
| `--module <name>` | yes | Module to add the cron to. |
| `--force` | no | Overwrite. |

#### `g doctor`

Project health check. Validates env vars, checks for un-applied migrations, runs `npm audit`, and reports findings. No arguments.

### `migrate-orm` — TypeORM → Drizzle codemod

```sh
ship-api migrate-orm [path] [options]
```

Walks a directory tree, parses each `.ts` file with the TypeScript compiler API, and reports / rewrites TypeORM entities into Drizzle schemas. Used during the v3 → v4 migration window.

**Arguments:**

| Argument | Default | Description |
| --- | --- | --- |
| `[path]` | `.` | File or directory to scan. |

**Options:**

| Flag | Default | Description |
| --- | --- | --- |
| `--write` | `false` | Emit Drizzle schemas next to entities. Default is analyze-only. |

**Decorator support:**

| Decorator | Classification | Notes |
| --- | --- | --- |
| `@Entity` | auto | → `pgTable(name, {...})` |
| `@Column` (primitives) | auto | varchar / int / boolean / etc. |
| `@Column` (custom transformers / types) | partial | flagged with TODO marker |
| `@PrimaryGeneratedColumn` | auto | → `uuid("id").primaryKey().defaultRandom()` |
| `@CreateDateColumn` | auto | → `baseFields.createdAt` (renamed from `createdDate`) |
| `@UpdateDateColumn` | auto | → `baseFields.updatedAt` (renamed from `updatedDate`) |
| `@DeleteDateColumn` | auto | → `baseFields.deletedAt` (renamed from `deletedDate`) |
| `@OneToMany` / `@ManyToOne` / `@ManyToMany` | partial | `relations()` block; review eager-loading semantics |
| `@BeforeInsert` / `@AfterInsert` / etc. | manual | → `DrizzleEntityService` lifecycle hooks |
| `@TreeEntity` / `@ViewEntity` / `@VersionColumn` | manual | no Drizzle equivalent |

Manual findings emit `// TODO[ship-api migrate-orm]:` comments — grep for them after the codemod runs.

Example:

```sh
# Analyze the entire src/ tree
ship-api migrate-orm src/

# Analyze and emit schema files
ship-api migrate-orm src/ --write
```

See [migration-v3-to-v4](/migration-v3-to-v4/) for the full walkthrough.

### `add` — module / library installer

```sh
ship-api add <name> [options]
```

Installs a module or library from the framework's published package into a consumer project. Used for shared modules and libraries (`ai/`, `chunking/`, `email/`, `weaviate/`).

**Arguments:**

| Argument | Required | Description |
| --- | --- | --- |
| `<name>` | yes | Module or library name. |

**Options:**

| Flag | Description |
| --- | --- |
| `-l, --lib` | Treat the name as a library, not a module. Libraries copy to `src/lib/<name>/`. |
| `-f, --force` | Overwrite existing. |

**What it does for modules:**

1. Verifies the cwd is a ShipAPI project (checks `@sixthsummit/ship-api` in `package.json`).
2. Locates the module under `lib/modules/<name>` (published) or `../../modules/<name>` (dev monorepo).
3. Reads the module's `module.json` for dependencies, required env vars, post-install hints.
4. Recursively installs declared dependencies (other modules or libraries).
5. Copies the module files to `src/modules/<name>/` (skipping `module.json`).
6. Updates `src/config/modules.ts` to register the module.
7. Runs `npm install` for any npm dependencies the module declares.
8. Prints the post-install guidance and any required / optional env vars.

For libraries, the copy target is `src/lib/<name>/` and `src/config/modules.ts` isn't touched (libraries are imported, not registered).

### `update` — framework update

```sh
ship-api update [options]
```

Runs `npm update @sixthsummit/ship-api` and applies any framework-level migration steps the new version requires.

**Options:**

| Flag | Description |
| --- | --- |
| `-f, --force` | Force the update even when conflict detection flags potential issues. |

The command currently handles a few specific upgrade paths (e.g. ensuring `reflect-metadata` is imported in `src/index.ts` for v3 → v4 transitions). It's a low-frequency tool for breaking version upgrades; routine version bumps go through `npm update` directly.

## Exit codes and error handling

All commands exit `0` on success, non-zero on failure. Specific errors (template not found, missing module, etc.) print a structured message and exit `1`. Unhandled errors (uncaught exceptions) print the error and exit `1`. Hooks like `dev`'s child-process forwarding set the exit code to the child's exit code.

## Source

- [`packages/core/cli/`](https://github.com/sixthsummit/ship-api/tree/main/packages/core/cli) — every command implementation
- [`packages/core/templates/`](https://github.com/sixthsummit/ship-api/tree/main/packages/core/templates) — `default` (v3 reference) and `v4` (modern) templates
- The Claude Code plugin's [`commands/`](https://github.com/sixthsummit/ship-api/tree/main/packages/claude-plugin/commands) — slash-command counterparts (`/ship:new-module`, `/ship:lint-conventions`)
