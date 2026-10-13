---
name: ship-module-pattern
description: Use when designing OR scaffolding a new ShipAPI v4 module — user mentions "new module", "billing module", "notifications module", "design a module", or starts editing files under `modules/<name>/` for a not-yet-implemented module. Loads the canonical 7-file shape, the dependency-injection pattern, and the composition contract with the consumer's `createApp({ schema })`.
---

# ShipAPI v4 — module pattern

> **Source**: `.cursor/rules/project-patterns.mdc` and the canonical references at `modules/accounts/`, `modules/oauth/`, `modules/outbox/`.

## Layout (the 7-file canonical shape)

```
modules/<name>/
├── module.json                                — manifest
├── schema.ts                                  — Drizzle pgTable + relations + types + status helpers
├── permissions.ts                             — slug constants + _DEFINITIONS for seeding
├── validation/schemas.ts                      — Zod schemas (create, update, idParam, listQuery)
├── services/<NameSingular>Service.ts          — extends DrizzleEntityService
├── routes.ts                                  — buildXxxApp(deps) + defineXxxRoutes(app, deps)
└── index.ts                                   — public barrel
```

Plus optional subdirectories — `jobs/<x>.job.ts`, `cron/<x>.cron.ts`, `handlers/<x>.ts`, `schemas/<x>.ts` (additional tables) — when the module needs them. Don't pre-create empty ones.

## Dependency injection

Routes and services take dependencies through plain options objects, not service-locator patterns:

```ts
export interface XxxRoutesDeps<TAccount = unknown> {
  service: XxxService;
  provider: AuthProvider<TAccount>;
  // … any module-specific deps (adapters, resolvers, …)
}

export function buildXxxApp(deps: XxxRoutesDeps) {
  return defineXxxRoutes(createModuleApp("xxx"), deps);
}
```

The consumer composes everything in their app bootstrap by mounting each module's sub-app on the root:

```ts
const service = new XxxService(db);
const provider = new FirebaseAuthProvider(...);
const app = root.route("/", buildXxxApp({ service, provider }));
```

This shape lets tests inject fakes (mock provider, fake-DB-backed service) without touching framework globals.

## Composition with `createApp({ schema })`

The framework's `createApp<TSchema>({ schema })` is generic over the consumer's composed schema. Each module exports its `pgTable` from its `schema.ts`; the consumer spreads + overrides:

```ts
import { accountsSchema } from "./modules/accounts";
import { invoices, invoicesRelations } from "billing";
import { customAccounts } from "./schema/accounts";

const schema = {
  ...accountsSchema,
  accounts: customAccounts,
  invoices,
  invoicesRelations,
};

const app = createApp({ schema });
```

Modules **don't** mutate global registries to add their tables — composition happens at one point in the consumer's bootstrap.

## Routes: build a sub-app, mount at root

`buildXxxApp(deps)` returns the module's **own** bounded sub-app on `createModuleApp("xxx")` (a CORS-less `createApp` sibling that tags each route with the module name). The consumer mounts it with `root.route("/", buildXxxApp(deps))`. Modules keep their **absolute** paths (`/xxx`, `/xxx/:id`), so mounting at `/` leaves the client shape (`api.xxx.$get`) and the route registry unchanged — no codegen. Mounting bounded sub-apps (instead of chaining every module onto one app) keeps each module's `tsc` route-type instantiation bounded, so the typed client scales to many modules without TS2589 ("instantiation excessively deep").

```ts
export function defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps) {
  return app
    .post("/xxx", ..., handler1)
    .get("/xxx", ..., handler2)
    .delete("/xxx/:id", ..., handler3);
}

export function buildXxxApp(deps) {
  return defineXxxRoutes(createModuleApp("xxx"), deps);
}
```

`defineXxxRoutes(app, deps)` is **kept** for back-compat / advanced composition but is a **foot-gun**: threading one shared `app` through several modules' definers accumulates one giant route-type and detonates `tsc` (TS2589), collapsing the `hc()` client to `never`. Prefer `buildXxxApp` + `root.route("/", ...)`. When you do use the raw form, keep it generic over Hono's schema param `S` and return the chained app — mutating `(app) => void` loses the RPC type chain entirely.

Cross-cutting middleware (`registerErrorHandlers`, `httpLogger`, CORS) lives on the **root only** — a sub-app must not set its own `onError` or `use("*")`.

## Permission slugs

Naming: `module:resource:action` (or `module:action` when there's no nested resource).

```ts
export const ACCOUNTS_PERMISSIONS = {
  read: "accounts:read",
  create: "accounts:create",
  update: "accounts:update",
  delete: "accounts:delete",
} as const;
```

Per-action granularity. Don't lump admin actions under read — the `outbox` module is the canonical example: `outbox:read` (anyone with read access) vs `outbox:drain` and `outbox:recover` (admin-only).

## Validation strictness

Use `.strict()` on object schemas — extra keys in client payloads then cause 400s instead of being silently dropped. Catches typos in client code that would otherwise look like silent no-ops.

```ts
export const createAccountSchema = z
  .object({
    email: z.string().email(),
    // ...
  })
  .strict();
```

## Service shape

Subclass `DrizzleEntityService<TableType, SchemaType>`:

```ts
export class XxxService extends DrizzleEntityService<
  typeof xxxTable,
  { xxxTable: typeof xxxTable }
> {
  protected getTable() { return xxxTable; }
  protected override getDefaultSearchFields(): readonly string[] { return [...]; }
  protected override getDefaultRelations(): readonly string[] { return [...]; }

  // Domain-specific methods:
  async findByXyz(xyz: string) { ... }
  async upsertSomething(...) { ... }
}
```

Inherit get / getAll / list / count / create / update / delete with soft-delete + audit-column auto-stamping. Domain methods own the table-specific lookups (`findByAccountAndProvider`, `claimForProcessing`, `recoverStaleProcessing`, …).

## Status / lifecycle helpers as pure functions

When a row has lifecycle states (oauth connection: expired/active/needsRefresh; outbox event: pending/processing/published/failed), express the predicates as **module-level pure functions** that take `Pick<Row, "fieldA" | "fieldB">`. v3 had these as instance methods on TypeORM entity classes; v4 rows are plain objects (`$inferSelect`), so the helpers move out of the row and become testable in isolation.

```ts
export function isExpired(conn: Pick<OAuthConnection, "expiresAt">): boolean {
  if (!conn.expiresAt) return false;
  return Date.now() >= conn.expiresAt.getTime();
}
```

## Tests

Two test files per module (canonical):

- `services/<NameSingular>Service.test.ts` — fake-Drizzle-backed unit tests of the service's domain methods
- `routes.test.ts` — integration test through the full chain (httpLogger → requireAuth → requirePermission → validate → handler)

Model the test harness after `modules/accounts/routes.test.ts` exactly — fake-DB shape, fake AuthProvider, `routeRegistry.clear()` in beforeEach, etc. Don't reinvent the harness shape.

## Quick scaffold

```sh
ship-api g module <name>           # full skeleton with default `name` column
ship-api g resource <name> --fields "title:string,body:text,published:boolean?"
ship-api g service <name> -m <module>
ship-api g schema <name> -m <module>
ship-api g job <name> -m <module>
ship-api g middleware <name>       # consumer-side middleware
```

Then customize. The `modules/accounts/` / `modules/oauth/` / `modules/outbox/` ports show what "customized" looks like for non-trivial modules — read them before writing new ones.
