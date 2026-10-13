# Agents Guide — your ShipAPI v4 app

This is the entry-point doc for any AI coding agent (Claude Code, Cursor, Codex, etc.) working in this app. Read it before doing anything.

## What this is

A TypeScript backend on **Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry**, scaffolded from `@sixthsummit/ship-api` v4. The framework is your dependency at `node_modules/@sixthsummit/ship-api/`; you write modules, schemas, routes, jobs, and tests against its primitives.

The framework's full agent guide lives at `https://github.com/SixthSummit/Ship/blob/main/AGENTS.md`. This doc is the consumer-side projection — patterns and gotchas that apply *inside this app*, not the framework's monorepo.

## Where things live

- `src/index.ts` — bootstrap only: load instrumentation, then dynamically import the server.
- `src/instrumentation.ts` — the early OpenTelemetry boundary; no application imports.
- `src/server.ts` — `createApp()` root; mount each module sub-app via `root.route("/", buildXxxApp(deps))`; `serve()`.
- `src/environment.ts` — `defineEnv(zodSchema)`. **The only application-config boundary for `process.env`; `instrumentation.ts` is the intentional early exception.**
- `src/db/schema.ts` — composed Drizzle schema (module schema fragments + your tables; the framework ships no default tables).
- `src/db/migrations/` — `drizzle-kit`-generated SQL. **Never hand-edit.**
- `src/config/modules.ts` — placeholder for planned module auto-wiring; today, wire modules in `src/server.ts`.
- `src/modules/<name>/` — your feature modules. Canonical 7-file shape: `schema.ts`, `permissions.ts`, `validation/schemas.ts`, `services/<NameSingular>Service.ts`, `routes.ts`, `index.ts`, `module.json`.
- `tests/` — integration tests.
- `drizzle.config.ts` — `drizzle-kit` config consumed by the `db:*` scripts.
- `docker-compose.yml` — Postgres + Redis + OTel collector for `ship-api dev`.
- `ship-api.config.ts` — Claude Code plugin activation marker (don't delete).

## Run, test, build

- `npm install` — install deps.
- `ship-api dev` — recommended dev workflow. Brings up Docker Compose deps, runs `tsx watch src/index.ts`, polls `/livez` until ready, prints the URL.
- `npm run build` — build to `lib/`.
- `npm start` — run built output.
- `npm test` — Vitest. The scaffold ships with `src/index.test.ts` as a sample (exercises `createApp` via `app.request("/...")` without booting a server) — use it as the pattern for your own tests; service tests next to the service, route tests at `src/modules/<name>/routes.test.ts`.
- `npm run lint` — ESLint.
- `npm run format` — Prettier write.
- `npm run type-check` — `tsc --noEmit`.
- `npm run db:generate -- --name <description>` — generate a migration from schema diffs.
- `npm run db:migrate` — apply pending migrations.
- `npm run db:studio` — Drizzle Studio web UI.

## Adding a feature

```sh
# Full canonical 7-file module shape (schema / permissions / validation /
# service / routes / index + module.json)
ship-api g module billing

# Or — when you already know the columns — a CRUD resource in one go:
ship-api g resource posts --fields "title:string,body:text,published:boolean,publishedAt:timestamp?"
```

> Scaffolding stamps a `scaffold.tool` breadcrumb into `module.json` for the by-tool delivery metric. Claude Code auto-detects; **Cursor users should export `SHIP_API_SCAFFOLD_TOOL=cursor`** first (Cursor has no reliable env marker), so the metric attributes correctly.

Then customize the generated files:

1. **Schema** — `src/modules/<name>/schema.ts` defines the Drizzle `pgTable` + relations + types. Use `...baseFields` for audit columns (`createdAt`, `updatedAt`, `deletedAt`, `createdBy`, `updatedBy`).
2. **Permissions** — `src/modules/<name>/permissions.ts` exports `module:resource:action` slug constants.
3. **Validation** — `src/modules/<name>/validation/schemas.ts` defines the Zod schemas. Use `.strict()` on object schemas.
4. **Service** — `src/modules/<name>/services/<NameSingular>Service.ts` extends `DrizzleEntityService<typeof table>`. Override `getDefaultSearchFields()` / `getDefaultRelations()` per module. Add domain-specific methods.
5. **Routes** — `src/modules/<name>/routes.ts` exports `buildXxxApp(deps)`, which returns the module's **own** sub-app via `defineXxxRoutes(createModuleApp("xxx"), deps)`. Each route chains: `requireAuth({ provider })` → `requirePermission(slug)` → `validate("json"|"query"|"param", schema)` → handler. `defineXxxRoutes(app, deps)` is kept as an advanced escape hatch (return the chained app, stay schema-generic) but threading one shared app through several modules detonates `tsc` — see the foot-gun note below.
6. **Compose** — mount each module sub-app onto the root in `src/server.ts`: `const app = root.route("/", buildXxxApp(deps))` (chaining the mounts), then `export type ShipApiClient = typeof app`. Modules keep their absolute paths, so the client shape is unchanged; cross-cutting concerns (`registerErrorHandlers`, `httpLogger`, CORS) live on the root only.
7. **Tests** — `<NameSingular>Service.test.ts` (fake-DB unit) + `routes.test.ts` (full-chain integration).
8. **Migration** — `npm run db:generate -- --name add_<name>_<change>` then commit the generated SQL.

## Conventions you must follow

The full rules are in `.cursor/rules/`. Read them when relevant. Indexed:

- @.cursor/rules/api.mdc — RESTful design, response shapes, error handling, **never write migrations manually**
- @.cursor/rules/typescript.mdc — coding standards, type / null safety
- @.cursor/rules/testing.mdc — Vitest patterns, mocking, route + service test shapes
- @.cursor/rules/security.mdc — Firebase auth, RBAC, permission system
- @.cursor/rules/commits.mdc — Conventional Commits

## Things agents commonly get wrong

- **Don't read `process.env` directly** outside `src/environment.ts` / `defineEnv()` and the early `src/instrumentation.ts` boundary. Module + handler code routes through the validated `env` object.
- **Don't hand-write SQL migrations.** Use `drizzle-kit generate` from schema source. The framework's plugin `PreToolUse` hook (`block-migration-edit.sh`) blocks edits to `src/db/migrations/*.sql` to enforce this.
- **Don't `console.log`.** Use `logger` from `@sixthsummit/ship-api/observability/logger`. `console.*` writes lose request-id + trace context.
- **Don't import from `node_modules/@sixthsummit/ship-api/lib/`.** Those are build artifacts. Import from package-export paths (`@sixthsummit/ship-api`, `@sixthsummit/ship-api/client`, etc.).
- **Don't use `c.req.json()` / `c.req.query()` / `c.req.param()`** directly. Register a Zod schema with `validate("json"|"query"|"param", schema)` and read via `c.req.valid(...)`. The route registry, typed client, and (eventual) OpenAPI all read off the registered schema. ESLint's `no-restricted-syntax` rule fires on raw use.
- **Don't import raw Drizzle operators (`eq`/`and`/`sql`/…) into a service.** Express queries via `DrizzleEntityService` + the `QueryOptions` DSL (raw Drizzle belongs in `src/db` / schema files). ESLint's `@typescript-eslint/no-restricted-imports` rule fires on a raw `drizzle-orm` value import outside the data-access layer; for specialized access (row locking, raw SQL) add a justified `eslint-disable`. Type-only imports are fine.
- **Don't skip `requireAuth({ provider })` / `requirePermission(slug)` middleware** on protected routes — authorization runs at the route, not on the controller.
- **Don't shape error responses inside handlers** — throw from the AppError taxonomy (`NotFoundError`, `BadRequestError`, etc.). `registerErrorHandlers(app)` shapes the JSON response uniformly.
- **Don't enqueue BullMQ jobs inside a transaction** — risks "queued before commit". Use the **outbox pattern** via `OutboxEventEmitter.emit({...}, { tx })`.
- **Don't thread one shared `app` through several `defineXxxRoutes` calls.** That accumulates one giant route-type and detonates `tsc` (TS2589). Build each module as its own sub-app with `buildXxxApp(deps)` (on `createModuleApp("xxx")`) and mount it via `root.route("/", buildXxxApp(deps))`. If you reach for the raw `defineXxxRoutes(app, ...)` escape hatch, keep it schema-generic and **return** the chained `app` (never `(app) => void`) so RPC types survive on `hc<ShipApiClient>()` consumers.
- **Don't commit secrets.** Env vars only.

## Consuming this app from clients

The cross-framework contract is `hc()` typed-client over your app's chained-app type. **No codegen.** Schema changes flow:

```
Drizzle table → drizzle-zod → zValidator → c.req.valid() → hc<ShipApiClient>()
```

through TypeScript types end-to-end.

**Server side** — mount each module sub-app on the root, then pin the typed-app alias:

```ts
// src/server.ts
import { createApp, registerErrorHandlers, httpLogger } from "@sixthsummit/ship-api";
import { buildAccountsApp } from "./modules/accounts";

const root = createApp({ cors });
registerErrorHandlers(root);          // root owns cross-cutting concerns
root.use("*", httpLogger());

const app = root
  .route("/", buildAccountsApp({ service: new AccountService(db), provider }));
export type ShipApiClient = typeof app;   // api.accounts.$get — flat shape
export { app };
```

**Client side** (web / mobile / another service) — import the type only:

```ts
import { hc } from "@sixthsummit/ship-api/client";
import type { ShipApiClient } from "@my-org/api/app";

export const api = hc<ShipApiClient>(BASE_URL, { init: { credentials: "include" } });
const me = await api.me.$get();
if (me.ok) { const account = await me.json(); /* typed end-to-end */ }
```

## How to verify your work

1. `npm run type-check` — passes.
2. `npm run lint` — passes (the `no-restricted-syntax` rule catches raw `c.req.json/query/param`).
3. `npm test` — passes.
4. `npx vitest run src/modules/<name>/` — module-specific tests pass.
5. If you touched routes — hit them via curl against `ship-api dev` and confirm status code, response shape, auth behavior.
6. If you touched the schema — `npm run db:generate -- --name <description>` produces a sane SQL diff.

## Claude Code specifics

The `@sixthsummit/ship-api-claude-plugin` auto-activates in this workspace (it detects the `ship-api.config.ts` marker file). You get:

- **Slash commands**: `/ship:lint-conventions [--diff|--all]`, `/ship:new-module <description>`, `/ship:add-job <name> -m <module>`, `/ship:add-cron <name> -m <module>`, `/ship:add-migration <name>`, `/ship:trace-request <request-id>`, `/ship:sherpa-brief [--base <ref>]`
- **Agents**: `ship-architect` (designs new modules), `ship-codegen` (executes a plan), `ship-reviewer` (audits a diff for v4 conventions — auto-fires on `Edit`/`Write` to `modules/**/*.ts` via the PostToolUse hook), `qa-brief` (generates a Sherpa-ready QA brief from the branch diff — invoked by the `sherpa-brief.yml` workflow on PR-to-`dev` and push-to-`dev`)
- **Skills**: ship-api-conventions, ship-module-pattern, ship-drizzle-migrations, ship-bullmq-jobs, ship-otel-debugging
- **MCP server tools**: `list_routes`, `describe_route`, `find_route_collisions`, `execute_route` (the load-bearing one — runs requests through the live middleware chain with pre-flight schema validation)

Tooling tips:

- Use `Edit` over `Write` for existing files.
- Use the `Explore` subagent for broad code searches; use direct `Grep`/`Read` for known paths.
- Don't spin long-running processes (`npm run dev`, `tsx watch`, etc.) — they stall the agent loop. Use `ship-api dev` only when the user explicitly asks; otherwise leave it to them.
- For UI / integration verification, ask the user to verify in their browser; don't claim "tested" without evidence.
- The plugin's MCP `execute_route` tool is the right way to drive routes during agent iteration; pre-flight schema validation surfaces schema errors *as* schema errors, not as opaque 500s.

## QA handoff (Sherpa briefs)

A `.github/workflows/sherpa-brief.yml` ships with this template. It auto-generates a plain-English QA brief from each branch's diff and hands it to the QA team via [Sherpa](https://github.com/sixthsummit/sherpa), with **zero engineer admin work**:

- **On PR-to-`dev`** — posts (or updates) a sticky preview comment on the PR. Informational; engineers can ignore it.
- **On push to `dev`** — posts the final brief to the QA Slack channel (`SLACK_QA_WEBHOOK_URL`) and uploads `brief.md` as a workflow artifact.

The brief is generated by the framework's `qa-brief` agent and contains plain-English flows the QA pastes into Sherpa's `/explore` — no Playwright code, no curl snippets. Editor-agnostic: Cursor and Claude Code engineers both get the same output via the CI path.

Add these repo secrets (Settings → Secrets and variables → Actions):

- `ANTHROPIC_API_KEY` — required for the headless agent run.
- `SLACK_QA_WEBHOOK_URL` — Incoming Webhook for the QA channel. Optional — the push-to-dev step skips Slack with a warning if unset.

If your deploy branch isn't `dev`, search-and-replace `dev` in the workflow's `on:` block. Local preview (Claude Code only): `/ship:sherpa-brief`. Full reference: [ShipAPI docs → Tooling → Sherpa QA briefs](https://docs.shipapi.dev/tooling/sherpa-qa-briefs).
