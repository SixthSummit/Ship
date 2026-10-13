# Code generators

> **Compatibility tooling:** these generators emit the monolithic seven-file
> route/service shape. New applications start from the focused operation
> scaffold and extend the explicit module/operation structure in code.

`ship-api g <type>` is the framework's scaffolding surface. Eight generators each emit canonical-shape code; agents and humans use the same templates so output is consistent regardless of who runs the command. This page covers the templates, the placeholder canonicalization, and what each generator writes.

## Why generators matter

Agents writing code from scratch tend to drift — slightly different file orderings, slightly different import patterns, slightly different test harnesses. The cumulative drift is hostile to anyone reading the codebase later. Generators hand the canonical shape to every agent, every time.

The convention applies to humans too. The bigger leverage isn't "agents make fewer typos"; it's "I can read any module in this repo and the seven files are in the same order with the same imports."

The CLI reference at [tooling/cli](cli.md) covers the surface — flags, args, what each command does at a glance. This page goes deeper: the templates, the placeholders, what gets written where.

## Name canonicalization

Every generator accepts a free-form name and emits canonical kebab-case-plural for paths plus parallel forms for code:

```
input        → namePlural    nameSingular  NamePlural   NameSingular  nameCamelPlural   nameCamelSingular   NAME_PLURAL    NAME_SINGULAR
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
accounts     → accounts       account       Accounts     Account       accounts          account             ACCOUNTS       ACCOUNT
Account      → accounts       account       Accounts     Account       accounts          account             ACCOUNTS       ACCOUNT
user-tokens  → user-tokens    user-token    UserTokens   UserToken     userTokens        userToken           USER_TOKENS    USER_TOKEN
userTokens   → user-tokens    user-token    UserTokens   UserToken     userTokens        userToken           USER_TOKENS    USER_TOKEN
USER_TOKENS  → user-tokens    user-token    UserTokens   UserToken     userTokens        userToken           USER_TOKENS    USER_TOKEN
```

The canonicalization is idempotent — passing canonical input through again produces the same output. The point is that every spelling lands at the same canonical form, so the generator output is identical regardless of how the user typed the name.

Templates use Mustache-style `{{...}}` placeholders for substitution:

| Placeholder | Use site |
| --- | --- |
| `{{namePlural}}` / `{{nameSingular}}` | paths, config keys, string literals |
| `{{nameCamelPlural}}` / `{{nameCamelSingular}}` | JS identifiers (variables, function names) |
| `{{NamePlural}}` / `{{NameSingular}}` | PascalCase (class names, type names) |
| `{{NAME_PLURAL}}` / `{{NAME_SINGULAR}}` | env-var-style constants |

## `g module <name>`

The flagship generator. Scaffolds a full v4 module — the canonical seven-file shape — at `src/modules/<namePlural>/`.

Files written, in order:

| File | Length | Content |
| --- | ---: | --- |
| `schema.ts` | ~21 lines | Drizzle `pgTable` + `relations` + `$inferSelect` / `$inferInsert` types. Uses `...baseFields`. |
| `permissions.ts` | ~25 lines | `MODULE_PERMISSIONS` slug constants (`read`, `create`, `update`, `delete`) and `MODULE_PERMISSION_DEFINITIONS` array for seeding. |
| `validation/schemas.ts` | ~31 lines | `create<Name>Schema`, `update<Name>Schema`, `list<NamePlural>QuerySchema`, `<nameSingular>IdParamSchema`. All `.strict()`. |
| `services/<NameSingular>Service.ts` | ~22 lines | Class extending `DrizzleEntityService<typeof <namePlural>>`. Empty body — module customizes from here. |
| `routes.ts` | ~122 lines | `build<NamePlural>App(deps)` (the module's own sub-app, on `createModuleApp`) plus `define<NamePlural>Routes(app, deps)` with the seven canonical routes: POST, GET (list), GET `/list` (paginated), GET `/count`, GET `/:id`, PUT `/:id`, DELETE `/:id`. `defineXxxRoutes` returns the chained app (advanced escape hatch); `buildXxxApp` is what you mount. |
| `index.ts` | ~29 lines | Public barrel. Re-exports the route function, service class, permission constants and definitions, validation schemas, and types. |
| `module.json` | ~14 lines | Manifest with `dependencies`, `requiredEnvVars`, `optionalEnvVars`, `postInstall` guidance. Used by `ship-api add`. |

After scaffolding, the generator prints next steps:

```
Next steps:
  • Add the schema to your composed schema:
      createApp({ schema: { ...accountsSchema, posts: posts } })
  • Mount the module's sub-app on the root (capture the return — it carries the RPC types):
      const routedApp = root.route("/", buildPostsApp({ service, provider }))
    and point the typed-client export at it:
      export type ShipApiClient = typeof routedApp
  • Run the migration:
      npm run db:generate
```

The generator is idempotent only with `--force`. By default, it refuses to overwrite an existing directory — hand-edited modules don't get clobbered by an accidental `g module` rerun.

## `g resource <name> --fields "..."`

A specialization of `g module` that customizes the schema and validation from a `--fields` spec.

```sh
ship-api g resource posts --fields "title:string,body:text,published:boolean,publishedAt:timestamp?,metadata:json?"
```

Behind the scenes, `g resource` runs `g module` first to lay down the canonical seven files, then post-processes `schema.ts` and `validation/schemas.ts` to swap the default placeholder field for the user-supplied fields.

Field syntax: `name:type[?]`. The trailing `?` marks the column as nullable in Drizzle (no `.notNull()`) and the field as `.optional()` in Zod.

Supported types and their substitutions:

| Spec | Drizzle column | Zod schema |
| --- | --- | --- |
| `string` | `varchar({ length: 255 })` | `z.string()` |
| `text` | `text()` | `z.string()` |
| `integer` | `integer()` | `z.number().int()` |
| `bigint` | `bigint({ mode: "number" })` | `z.number().int()` |
| `boolean` | `boolean()` | `z.boolean()` |
| `timestamp` | `timestamp({ withTimezone: true })` | `z.coerce.date()` |
| `uuid` | `uuid()` | `z.string().uuid()` |
| `json` | `jsonb().$type<Record<string, unknown>>()` | `z.record(z.string(), z.unknown())` |

Unknown types emit `text()` columns with a `// TODO[ship-api]:` marker, surfaced in the post-generation message — the generator never silently drops a field.

The generator's post-summary includes the field list, flags any `TODO`-marked entries, and reminds you to run `npm run db:generate` after reviewing the schema.

## `g service <name> --module <module>`

Adds an additional service to an existing module. Use when a module needs a second service alongside its primary — for example, `PostService` plus `PostDraftService` both inside `posts`.

Output: `src/modules/<module>/services/<NameSingular>Service.ts`. The generated class extends `DrizzleEntityService<typeof <table>, { table: typeof <table> }>` against the module's primary table by default; rewire to a different table if appropriate.

Required flag: `--module <name>`. Without it the generator can't know where to put the file.

## `g schema <name> --module <module>`

Adds an additional Drizzle table to an existing module. Use when a module owns more than one table — for example, `posts` plus `post_revisions` plus `post_tags`.

Output: `src/modules/<module>/schemas/<nameKebab>.ts` with a minimal `pgTable` skeleton:

```ts
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";

export const <namePlural> = pgTable("<namePlural>", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  ...baseFields,
});

export type <NameSingular> = typeof <namePlural>.$inferSelect;
export type New<NameSingular> = typeof <namePlural>.$inferInsert;
```

Customize in place; run `npm run db:generate` to emit the migration. The framework's never-edit-SQL-by-hand rule applies — see [concepts/database](../concepts/database.md).

## `g middleware <name>`

Scaffolds an app-level Hono middleware factory at `src/middleware/<nameKebab>.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@sixthsummit/ship-api";

export interface <NamePascal>Options {
  /* options go here */
}

export function <nameCamel>(opts: <NamePascal>Options = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Before-handler logic
    await next();
    // After-handler logic
  };
}
```

The framework's shared middleware (`requireAuth`, `requirePermission`, `validate`, `httpLogger`, `apiKey`, `rateLimit`, `idempotency`, `csrf`) live in `@sixthsummit/ship-api`. `g middleware` is for **app-specific** middleware — request enrichment, custom auth flows, anything bespoke to your application.

## `g job <name> --module <module>`

Scaffolds a BullMQ job stub at `src/modules/<module>/jobs/<nameKebab>.job.ts`:

```ts
import { z } from "zod";
import type { JobHandler } from "@sixthsummit/ship-api";

export const <nameCamel>PayloadSchema = z.object({
  /* fields */
}).strict();

export const <nameCamel>Job = {
  queue: "<module>",
  name: "<nameKebab>",
  payloadSchema: <nameCamel>PayloadSchema,
  async processor(payload, { job, context }) {
    // implementation
  },
};

export default <nameCamel>Job;
```

Auto-discovered at boot when `InitJobs` runs (priority 60). See [features/jobs](../features/jobs.md) for the runtime flow, retry semantics, and outbox pattern.

## `g cron <name> --module <module>`

Same shape as `g job` but uses `defineCron` and lands at `src/modules/<module>/cron/<nameKebab>.cron.ts`:

```ts
import { defineCron } from "@sixthsummit/ship-api";

export const <nameCamel>Cron = defineCron({
  name: "<nameKebab>",
  schedule: "0 2 * * *",         // edit to match
  tz: "UTC",                     // override if needed
  handler: async (_payload, { job }) => {
    // implementation
  },
});

export default <nameCamel>Cron;
```

Auto-discovered by `InitCron` (priority 65) and registered as a BullMQ repeatable.

## `g doctor`

Project health check. Runs four pure-introspection checks (no modifications, no installs):

1. **`project_structure`** — verifies `package.json` exists in cwd and depends on `@sixthsummit/ship-api`. Emits `ok` if valid, `warn` otherwise.
2. **`env_vars`** — reads every `module.json` under `src/modules/*/`. For each entry in `requiredEnvVars`, checks `process.env`; missing values fail. `optionalEnvVars` are logged at info level only.
3. **`drizzle_migrations`** — checks for `drizzle.config.{ts,js,json}` and counts SQL files under `src/db/migrations/`. Warns if config exists but no migrations have been generated, or if no config is present.
4. **`audit`** — runs `npm audit --json --audit-level=info` and `npx audit-ci --config .audit-ci.json` if the config file exists. Fails if any high or critical findings.

Output is a table:

```
status  name                  detail
─────────────────────────────────────────────────────────────────────
ok      project_structure     @sixthsummit/ship-api ^4.0.0-alpha.1
fail    env_vars              missing: STRIPE_API_KEY (required by billing)
warn    drizzle_migrations    drizzle.config.ts present; no migrations
ok      audit                 0 high, 0 critical
```

Exit code is 1 if any check is `fail`; otherwise 0. Useful as a CI step or a "did I configure the right env vars before deploying" sanity check.

## Customizing templates

The templates ship inside `packages/core/cli/templates/module/` — six `.tpl` files plus a `validation/` and `services/` subdirectory. They're conservative on purpose: every consumer's downstream patterns differ, and a heavy template forces customization that fights the generator.

If your team needs different defaults, the right approach is post-processing rather than editing the framework's templates: scaffold with `ship-api g resource ...`, then run a project-specific transform (a small script or a follow-up generator wrapper) that adds your house conventions. The framework's templates stay version-aligned with the framework; your transforms stay version-aligned with your app.

For one-off customizations, just edit the generated files. The generator deliberately doesn't run again on the same target without `--force`, so your edits are safe.

## Source

- [`packages/core/cli/commands/generate.js`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/cli/commands/generate.js) — the dispatcher and per-type implementations
- [`packages/core/cli/commands/doctor.js`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/cli/commands/doctor.js) — the four health checks
- [`packages/core/cli/templates/module/`](https://github.com/sixthsummit/ship-api/tree/main/packages/core/cli/templates/module) — `.tpl` files used by `g module` and `g resource`
- [tooling/cli](cli.md) — the surface-level reference for every command
- [tooling/claude-plugin](claude-plugin.md) — slash commands like `/ship:add-job` that wrap these generators
