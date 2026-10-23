# Ship monorepo

Use root pnpm install and Turbo build. API guidance follows below; Angular guidance is in [angular/AGENTS.md](angular/AGENTS.md) and applies to `packages/angular`, `apps/angular-docs`, and `angular`. Framework boundaries remain separate. Root [RELEASE_GUIDE.md](RELEASE_GUIDE.md) supersedes legacy repository release instructions. All changesets live at the root.

# Agents Guide — ShipAPI

## Current architecture: start here

ShipAPI is a pnpm workspace containing an operation-oriented application kernel and optional adapters. New features use the target packages below; `packages/core` is the existing v4 compatibility distribution, not the kernel. The remainder of this document describes that compatibility surface and applies only when maintaining it. The [README](README.md), [accepted ADRs](docs/rearchitecture/decisions/README.md), and [implementation status](docs/V4_STATUS.md) are the target architecture source of truth.

| Directory / package | Responsibility |
| --- | --- |
| `packages/kernel` / `@sixthsummit/ship-core` | Operations, modules, provider graph, execution, access and tenant capabilities |
| `packages/hono` / `@sixthsummit/ship-hono` | HTTP transport declarations and projection |
| `packages/drizzle` / `@sixthsummit/ship-drizzle` | Transaction-scoped domain repositories and explicit predicates |
| `packages/contract` / `@sixthsummit/ship-contract` | Client-safe structural contracts, generated clients, codecs and OpenAPI |
| `packages/auth-firebase`, `packages/observability-otel`, `packages/cache-redis` | Optional auth, telemetry and cache adapters |
| `packages/realtime-socketio` / `@sixthsummit/ship-realtime-socketio` | Socket.IO + Redis gateway for kernel channels (`defineChannel`); wire protocol in `docs/v4/realtime.md` |
| `packages/jobs-bullmq`, `packages/webhooks` | Optional jobs backend and provider webhook verifiers |
| `packages/push` / `@sixthsummit/ship-push` | Optional VAPID Web Push sender; apps own subscription storage and delivery jobs |
| `packages/auth-credentials` / `@sixthsummit/ship-auth-credentials` | First-party credential auth: password accounts, email verification, TOTP MFA, recovery codes, sessions with revocation, lockout and the auth audit log as declared operations plus an actor provider beside Firebase; tables under `./drizzle`, console panel under `./console`; UI in `@sixthsummit/ship-angular/credential-auth` |
| `packages/console` / `@sixthsummit/ship-console` | Operator console module: jobs, cron, webhook receipts, realtime channels and outboxes as declared operations behind `console.operate`; UI in `@sixthsummit/ship-angular/console` |
| `packages/storage` / `@sixthsummit/ship-storage` | Declared managed storage: attachment module with signed upload intents, fenced completion, orphan sweep, lazy variants and durable purge; disk, S3/R2 and GCS adapters (`defineAttachment` lives in the kernel) |
| `packages/rich-text` / `@sixthsummit/ship-rich-text` | Declared rich text fields: validator, sanitizer, HTML renderer, plain-text projection, migration hook and the `richTextProvider` capability that reconciles embedded managed attachments with the owning record (`defineRichText` / `defineRichTextExtension` live in the kernel; ADR-0026, `docs/v4/features/rich-text.md`) |
| `packages/mail` / `@sixthsummit/ship-mail` | Declared transactional mail: `defineMailDelivery` on the jobs capability, typed sender, send ledger, allowlist interceptor, previews, log + Resend adapters (`defineMailer` lives in the kernel; ADR-0023, `docs/v4/features/mail.md`) |
| `packages/schema-lint` / `@sixthsummit/ship-schema-lint` | Migration linter for the production column rules, canonical schema snapshot check, gated release preset and boot-time guard; see `docs/v4/features/schema-safety.md` |
| `packages/testing`, `packages/cli` | Parity/integration harness and graph/contract tooling |
| `packages/core` / `@sixthsummit/ship-api` | Existing route-first v4 compatibility APIs and scaffolds |

For new application work:

1. Define an operation with stable ID, input/output schemas, access, errors, dependencies, transaction mode and effects. Compose operations/providers with `defineModule` and `defineApp`.
2. Put access policy on the operation so direct execution and HTTP share it. A singleton provider must never retain an operation-lifetime dependency.
3. Inject a unit-of-work capability for transactional operations. Construct explicit domain repositories from its Drizzle transaction. Raw Drizzle operators belong in those repositories; there is no requirement to extend the compatibility `DrizzleEntityService`. Do not detach work from the transaction callback or retain transaction capabilities after it completes.
4. Authorize tenant selection with `createTenantScopeAuthority`; repositories accept authentic capabilities, not raw request tenant IDs. Domain repositories still apply tenant predicates.
5. Declare HTTP transport with `ship-hono`, then project the compiled app. Generate browser-safe contracts/clients through `ship-contract`/`ship-cli`; client code must not import the backend app graph. The compatibility `hc()`/no-codegen instructions below do not apply to this path.
6. Test kernel behavior, direct/HTTP/client parity and real PostgreSQL rollback/isolation as applicable. Use `fixtures/consumers/minimal` and `fixtures/consumers/customized` as target examples. Run the root verification commands below with the Node/pnpm versions pinned in `package.json`; formatting/linting uses Biome and focused architecture rules.

The kernel and compatibility distribution have stable releases; `dev` publishes alpha snapshots of pending changes. Streaming responses and declared realtime publication are implemented (ADRs 0016/0017). Application migration gates and any remaining deferred capabilities still require their own evidence.

## Compatibility maintenance reference


This is the entry-point doc for any AI coding agent (Claude Code, Cursor, Codex, etc.) working in this repo. Read it once before doing anything.

## What this is

ShipAPI is a TypeScript backend framework — published as `@sixthsummit/ship-api` — built on **Hono + Drizzle + pluggable AuthProvider + BullMQ + OpenTelemetry + Claude Code plugin**. The compatibility distribution lives in the pnpm workspace:

- `packages/core/` — the framework (`@sixthsummit/ship-api`)
- `packages/claude-plugin/` — the Claude Code plugin (`@sixthsummit/ship-api-claude-plugin`)
- `packages/mcp-server/` — the MCP server (`@sixthsummit/ship-api-mcp-server`)
- `modules/` — feature modules: `accounts/`, `oauth/`, `outbox/`
- `libraries/` — shared utility libraries (`ai/`, `chunking/`, `email/`, `weaviate/`)
- `apps/docs/` — Astro + Starlight docs site (v4 projection of `/docs/*`)

Consumers run `npx ship-api create my-app` to scaffold a v4 reference app.

> **Status:** stable v4 compatibility distribution; exact versions are recorded in package manifests and changelogs. See [docs/V4_STATUS.md](docs/V4_STATUS.md) for the implementation tracker and remaining gates. Consumers migrating up from v3 follow [docs/MIGRATION_V3_TO_V4.md](docs/MIGRATION_V3_TO_V4.md), which is hardened against two real-world dry-runs.

## Where things live

### Framework source (`packages/core/src/`)

- **`app/`** — primitives:
  - `app/auth/` — `AuthProvider` interface + `FirebaseAuthProvider` adapter
  - `app/auth/jwt/` — `JwtSigner` (ES256), `AuthFlow`, `RefreshTokenStore`
  - `app/db/` — `client` (drizzle pool), `baseFields` (audit-column mixin), `transaction`, `QueryOptions` (neutral operator DSL)
  - `app/schema/` — **removed**; identity/RBAC tables (accounts / roles / permissions / refresh_tokens) now live in `modules/accounts`, core ships no concrete tables
  - `app/services/DrizzleEntityService.ts` — generic CRUD/list/search base
  - `app/services/jobs/` — `defineJob`, `JobRegistry`, `JobsManager`
  - `app/services/cron/` — `defineCron`
  - `app/registry/routes.ts` — runtime route registry (read by MCP tools, agents, `/dev/routes`)
  - `app/lifecycle/Bootstrapper.ts` — priority + dependsOn ordering
  - `app/health/HealthCheck.ts` — `HealthCheckRegistry`
  - `app/services/cache/`, `app/services/storage/` — Cache + Disk/S3/GCS adapters

- **`http/`** — HTTP layer:
  - `http/app/createApp.ts` — `Hono<AppEnv>` factory with route-method interception
  - `http/app/errors.ts` — `registerErrorHandlers(app)` for the AppError taxonomy
  - `http/middleware/` — `requireAuth`, `requirePermission`, `apiKey`, `rateLimit`, `idempotency`, `csrf`, `httpLogger`
  - `http/utils/validate.ts` — `validate("json"|"query"|"param", schema)` zValidator wrapper
  - `http/streaming/` — `streamSSE`, `streamLLM` (SSE bridge for LLM provider streams)
  - `http/ws/` — `@hono/node-ws` adapter + subprotocol-header authentication

- **`observability/`** — pino logger, OpenTelemetry SDK, Prometheus metrics exporter, `withSpan` helper

- **`client.ts`** — typed-client subpath (`@sixthsummit/ship-api/client`)

### Reference template (`packages/core/templates/default/`)

The v4 reference app produced by `ship-api create my-app`. Has its own `AGENTS.md` + `CLAUDE.md` aimed at consumer apps.

### CLI (`packages/core/cli/`)

- `commands/create.js` — `ship-api create my-app` (uses `packages/core/templates/default/`)
- `commands/dev.js` — `ship-api dev` (Docker Compose deps + `tsx watch` + `/livez` polling)
- `commands/generate.js` — `ship-api g {module|resource|service|schema|middleware|job|doctor}`
- `commands/migrate-orm.js` — `ship-api migrate-orm <path> [--write]` (TypeORM → Drizzle codemod for consumers migrating up from v3)
- `commands/add.js` — `ship-api add <module>` / `add -l <library>`
- `commands/update.js` — `ship-api update`
- `templates/module/` — `g module` template (the consumer reference template lives at `packages/core/templates/default/`)

### Documentation

- `AGENTS.md` (this file) — agent onboarding entry point
- `docs/V4_STATUS.md` — what's done, what's outstanding, what's deferred to v4.x
- `docs/MIGRATION_V3_TO_V4.md` — codemod-assisted parallel-path migration walkthrough
- `.cursor/rules/*.mdc` — **canonical project guidelines** (synced into the Claude plugin's SKILL.md files via `pnpm run sync:skills` / `check:skills` CI guard)

### Scripts (`scripts/`)

- `sync-skills.mjs` / `check-skills-sync.mjs` — `.cursor/rules/` ↔ SKILL.md drift detection
- `edge-smoke/` — Cloudflare Workers smoke-test fixture (`pnpm dlx wrangler deploy --dry-run`)
- `build-core.js` — post-`tsc` dual-emit work for the framework package

## Run, test, build

From repo root:

- `pnpm install --frozen-lockfile` — install all workspace deps.
- `pnpm run build` — build the core framework into `packages/core/lib/`.
- `pnpm test` — Vitest across the framework package.
- `pnpm run check` — Biome formatting/lint/import checks plus focused architecture lint.
- `pnpm run check:fix` — apply safe Biome fixes, then run architecture lint.
- `pnpm run format` — Biome formatter write.
- `pnpm run type-check` — `tsc --noEmit`.
- `pnpm run check:skills` — drift detection between `.cursor/rules/` and SKILL.md.
- `pnpm run sync:skills` — re-pin the rule hashes after editing a rule.
- `pnpm run audit` — runtime-only `audit-ci` high/critical hard-fail.
- `pnpm run verify:fast` — source checks + TypeScript + tests affected by committed changes.
- `pnpm run ci` — merge loop: source checks + skills + TypeScript + build + unit tests.
- `pnpm run verify` — full phase gate, including coverage, integration, parity, edge, package, docs, and runtime audit.

Use pnpm filters for one workspace (for example, `pnpm --filter @sixthsummit/ship-api-mcp-server test`).

## Adding a v4 feature module

```sh
# 1. Scaffold (full canonical 7-file shape: schema / permissions /
#    validation / service / routes / index + module.json)
ship-api g module billing

# Or, when you already know the schema columns:
ship-api g resource posts --fields "title:string,body:text,published:boolean,publishedAt:timestamp?"
```

> The scaffold stamps a `scaffold.tool` breadcrumb into `module.json` for the by-tool delivery metric ([`DELIVERY_METRICS.md`](docs/DELIVERY_METRICS.md) M6). Claude Code auto-detects; **Cursor has no reliable env marker, so Cursor users should export `SHIP_API_SCAFFOLD_TOOL=cursor`** before scaffolding (otherwise the run attributes to `cli`).

Then customize the generated files. The canonical references for non-trivial modules are `modules/accounts/` (CRUD), `modules/oauth/` (multi-step flow + provider adapters + state signing), and `modules/outbox/` (transactional outbox + drainer orchestration). **Read the relevant reference before adding a non-trivial module.**

Steps:

1. Define the table in `schema.ts` (Drizzle `pgTable` + relations + types). Use `...baseFields` for the audit columns.
2. Define permission slugs in `permissions.ts` as `module:resource:action` constants.
3. Define Zod validation schemas in `validation/schemas.ts`. Use `.strict()` on object schemas.
4. Define the service in `services/<NameSingular>Service.ts` extending `DrizzleEntityService<typeof table>`. Override `getDefaultSearchFields()` / `getDefaultRelations()` per module. Add domain-specific methods.
5. Define the routes in `routes.ts`: expose `buildXxxApp(deps)` returning the module's **own** sub-app via `defineXxxRoutes(createModuleApp("xxx"), deps)`. Each route chains: `requireAuth({ provider })` → `requirePermission(slug)` → `validate("json"|"query"|"param", schema)` → handler. `defineXxxRoutes(app, deps)` is kept as a back-compat / advanced escape hatch (return the chained app, stay schema-generic), but threading one shared app through several modules detonates `tsc` — see the foot-gun note below.
6. Mount each module sub-app onto the root in `src/index.ts`: `const app = root.route("/", buildXxxApp(deps))` (chaining the mounts), then `export type ShipApiClient = typeof app`. Cross-cutting concerns (`registerErrorHandlers`, `httpLogger`, CORS) live on the root only.
7. Write tests at `services/<NameSingular>Service.test.ts` (fake-DB unit) + `routes.test.ts` (full-chain integration). Mirror the harness from `modules/accounts/routes.test.ts`.
8. Generate the migration: `npm run db:generate -- --name <description>`.

## Conventions you must follow

The full rules are in `.cursor/rules/`. Read them when relevant; the indexed view:

- @.cursor/rules/project-patterns.mdc — module structure, controller/service/entity/validation patterns
- @.cursor/rules/typescript.mdc — coding standards, type/null safety, `DrizzleEntityService` patterns
- @.cursor/rules/api.mdc — RESTful design, response formats, security, error handling, **never write migrations manually**
- @.cursor/rules/testing.mdc — Vitest patterns, mocking, controller/service test shapes
- @.cursor/rules/security.mdc — Firebase auth, RBAC, account-based auth, permission system
- @.cursor/rules/commits.mdc — Conventional Commits + Changesets workflow (add a `.changeset/*.md` file for user-visible changes via `npx changeset`)
- @.cursor/rules/template-development.mdc — library import rules; no `.js` extensions on library imports; Permission entities over constants

The plugin's SKILL.md files (in `packages/claude-plugin/skills/*/SKILL.md`) are auto-loaded summaries of the same rules — agents see them in context when working on a ShipAPI repo.

## Consuming ShipAPI from clients

The v4 cross-framework contract is `hc()` typed-client over the framework's chained-app type. **No codegen.** Schema changes flow:

```
Drizzle table → drizzle-zod → zValidator → c.req.valid() → hc<ShipApiClient>()
```

through TypeScript types end-to-end.

**Server side** — mount each module sub-app on the root, then pin the typed-app alias:

```ts
// src/index.ts (consumer)
import { createApp, registerErrorHandlers, httpLogger } from "@sixthsummit/ship-api";
import { buildAccountsApp } from "./modules/accounts";

const root = createApp({ cors });
registerErrorHandlers(root); // root owns cross-cutting concerns
root.use("*", httpLogger());

const app = root.route("/", buildAccountsApp({ service: new AccountService(db), provider }));
export type ShipApiClient = typeof app; // api.accounts.$get — flat shape
export { app };
```

Each module builds its own bounded sub-app via `buildXxxApp(deps)` (on `createModuleApp("xxx")`) and mounts at `/` keeping its absolute paths — so the client shape and route registry are unchanged, and mounting bounded sub-apps (rather than threading one app through every `defineXxxRoutes`) keeps `tsc`'s route-type instantiation bounded so the typed client scales to many modules. The raw `defineXxxRoutes(app, deps)` form is kept but is a foot-gun (threading one shared app detonates `tsc` with TS2589); when used it must return the chained `app` and stay schema-generic.

**Client side** — import the type only, instantiate `hc()`:

```ts
import { hc } from "@sixthsummit/ship-api/client";
import type { ShipApiClient } from "@my-org/api/app";

export const api = hc<ShipApiClient>(BASE_URL, { init: { credentials: "include" } });
const me = await api.me.$get();
if (me.ok) {
  const account = await me.json(); /* typed end-to-end */
}
```

For apps that handle errors centrally, `@sixthsummit/ship-api/client` also exports `ShipApiSuccessClient<App>`, which narrows the client to success-status (200|201) responses.

ShipAngular `createResource()` and React Native + Expo + TanStack Query both consume the same client.

## Things agents commonly get wrong (v4)

- **Don't read `process.env` directly** outside `src/environment.ts` / `defineEnv()`. Module + handler code routes through the validated `env` object. Framework code reads env at init-time boundaries only — accepted boundary points: `observability/otel.ts`, `observability/metrics.ts`, `observability/logger.ts` (pretty-print gating), `app/defineEnv.ts`, `app/services/jobs/JobsManager.ts` (worker-mode resolution), `http/utils/authCookies.ts` (cookie-secure gating), `http/app/errors.ts` (dev-stack disclosure gating).
- **Don't hand-write SQL migrations.** Use `drizzle-kit generate` from schema source. The plugin's PreToolUse hook (`block-migration-edit.sh`) blocks edits to `src/db/migrations/*.sql` to enforce this.
- **Don't `console.log`** in framework or module code. Use `logger` from `@sixthsummit/ship-api/observability/logger`. console writes lose request-id + trace context.
- **Don't import from `lib/`** — those are build artifacts. Import from source paths (`@sixthsummit/ship-api/...`).
- **Don't use `c.req.json()` / `c.req.query()` / `c.req.param()`** directly. Register a Zod schema with `validate("json"|"query"|"param", schema)` and read via `c.req.valid(...)`. The route registry, typed client, and (eventual) OpenAPI all read off the registered schema. ESLint's `no-restricted-syntax` rule fires on raw use.
- **Don't import raw Drizzle operators (`eq`/`and`/`sql`/…) into a service.** Express queries via `DrizzleEntityService` + the `QueryOptions` DSL so an ORM swap touches only the data-access layer (`app/db`, `DrizzleEntityService`, schema). ESLint's `@typescript-eslint/no-restricted-imports` rule fires on a raw `drizzle-orm` value import outside that layer; for specialized access (row locking, raw SQL) add a justified `eslint-disable`. Type-only imports are fine.
- **Don't skip `requireAuth({ provider })` / `requirePermission(slug)` middleware** on protected routes — authorization runs at the route, not on the controller. The `ship-reviewer` agent flags missing chains.
- **Don't shape error responses inside handlers** — throw from the AppError taxonomy (`NotFoundError`, `BadRequestError`, etc.). `registerErrorHandlers(app)` shapes the JSON response uniformly.
- **Don't enqueue BullMQ jobs inside a transaction** — risks "queued before commit" (worker queries the DB and doesn't see the row). Use the **outbox pattern** via `OutboxEventEmitter.emit({...}, { tx })`.
- **Don't import test fixtures via source paths (`../../app/...`) when modules import via `@sixthsummit/ship-api/...`** — class identities differ between source and built lib, breaking `instanceof AppError` checks. Stick to package-export paths everywhere.

## How to verify your work

Before declaring done:

1. `pnpm run type-check` — passes.
2. `pnpm run check` — passes (Biome plus the focused architecture rules).
3. `pnpm --filter @sixthsummit/ship-api test` — passes.
4. `pnpm exec vitest run modules/<name>/` — module-specific tests pass.
5. `pnpm run check:skills` — `.cursor/rules/` ↔ SKILL.md drift detection clean.
6. `pnpm --filter @sixthsummit/ship-api build` — the framework still builds cleanly.
7. `pnpm run audit:runtime` — no high/critical findings in the published runtime graph.
8. If you touched the http/ slice: the edge-smoke CI step verifies the bundle still compiles for Cloudflare Workers (`scripts/edge-smoke/`).

## Claude Code specifics

Claude-specific config inherits from `~/.claude/`. The plugin lives at `packages/claude-plugin/` (`@sixthsummit/ship-api-claude-plugin`):

- **Slash commands**: `/ship:lint-conventions [--diff|--all]`, `/ship:new-module <description>`, `/ship:add-job <name> -m <module>`, `/ship:add-cron <name> -m <module>`, `/ship:add-migration <name>`, `/ship:trace-request <request-id>`, `/ship:sherpa-brief [--base <ref>]`
- **Agents** (callable via `Agent` tool): `ship-architect` (designs new modules), `ship-codegen` (executes a plan), `ship-reviewer` (audits a diff for v4 conventions), `qa-brief` (generates a Sherpa-ready QA brief from a backend diff)
- **Skills** (auto-loaded in ShipAPI repos): ship-api-conventions, ship-module-pattern, ship-drizzle-migrations, ship-bullmq-jobs, ship-otel-debugging
- **Hooks**: PreToolUse blocks migration edits; PostToolUse hints `ship-reviewer` after touching module files; Stop reminds to run type-check + lint + tests before commit
- **MCP server**: `list_routes`, `describe_route`, `find_route_collisions`, **`execute_route`** (the load-bearing differentiator — agents iterate against the real middleware chain in the running dev server)

Tooling tips:

- Use `Edit` over `Write` for existing files.
- Use the `Explore` subagent for broad code searches; use direct `Grep`/`Read` for known paths.
- Don't spin long-running processes (`npm run dev`, `tsx watch`, etc.) — they stall the agent loop. Use `ship-api dev` only when the user explicitly asks; otherwise leave it to them.
- For UI/integration verification, ask the user to verify in their browser; don't claim "tested" without evidence.
- The plugin's MCP `execute_route` tool is the right way to drive routes during agent-iteration; pre-flight schema validation surfaces schema errors _as_ schema errors, not as opaque 500s.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
