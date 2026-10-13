---
name: ship-api-conventions
description: Use when working on a ShipAPI v4 codebase — files under modules/, packages/core/src/, libraries/ai/, or template content. Triggers on edits to any TS file in a ShipAPI repo (presence of `modules/`, `packages/core/`, or `ship-api.config.ts` is the signal). Loads the load-bearing v4 conventions: how to register routes, validate inputs, enforce auth, structure services, declare permissions. The full canonical rules live in `.cursor/rules/*.mdc` — this skill is the synced summary.
---

# ShipAPI v4 conventions

> **Source**: synced from `.cursor/rules/*.mdc`. Edit there, not here. Run `npm run sync:skills` to regenerate.

## Module shape (the load-bearing pattern)

A v4 module lives at `modules/<name>/`. Required files:

```
modules/<name>/
├── module.json                 — manifest (name, deps, env vars, postInstall)
├── schema.ts                   — Drizzle pgTable + relations + types
├── permissions.ts              — slug constants + seed-friendly definitions
├── validation/schemas.ts       — Zod schemas (create, update, idParam, listQuery)
├── services/<NameSingular>Service.ts   — extends DrizzleEntityService
├── routes.ts                   — buildXxxApp(deps) + defineXxxRoutes(app, deps)
└── index.ts                    — public barrel
```

The canonical references are `modules/accounts/`, `modules/oauth/`, `modules/outbox/`. Read them before adding new modules.

## Routes

Each module exposes `buildXxxApp(deps)` returning its **own** bounded sub-app on `createModuleApp("xxx")` (a CORS-less `createApp` sibling that tags each route with the module name). The consumer mounts it with `root.route("/", buildXxxApp(deps))`:

```ts
export function defineXxxRoutes<S extends Schema>(app: Hono<AppEnv, S>, deps: { service, provider }) {
  const auth = requireAuth({ provider: deps.provider });
  return app
    .post("/xxx",
      auth,
      requirePermission(XXX_PERMISSIONS.create),
      validate("json", createXxxSchema),
      async (c) => {
        const body = c.req.valid("json");
        const row = await deps.service.create(body);
        return c.json(row, 201);
      })
    .get(...);
}

export function buildXxxApp(deps) {
  return defineXxxRoutes(createModuleApp("xxx"), deps);
}
```

Modules keep their **absolute** paths and mount at `/`, so the client shape (`api.xxx.$get`) and the route registry are unchanged — no codegen. Mounting bounded sub-apps (instead of threading one shared `app` through every module's definer) keeps each module's `tsc` route-type instantiation bounded, so the typed client scales to many modules.

**`defineXxxRoutes(app, deps)` is kept but is a foot-gun.** Threading one shared `app` through several modules' definers accumulates one giant route-type and detonates `tsc` (TS2589 / "instantiation excessively deep"), collapsing the `hc()` client to `never`. Prefer `buildXxxApp` + `root.route("/", ...)`. When you do use the raw form: **return the chained `app`** (mutating `(app) => void` loses the type chain) and **stay generic over Hono's schema param `S`** — a plain `app: Hono<AppEnv>` (or `<T extends Hono<AppEnv>>`) widens an already-chained app and erases previously wired modules' routes from the client type. `Hono<AppEnv, S>` accumulates: the return is `Hono<AppEnv, S & <these routes>>`.

Cross-cutting middleware (`registerErrorHandlers`, `httpLogger`, CORS) lives on the **root only** — a sub-app must not set its own `onError` or `use("*")`.

## Auth + authorization

- `requireAuth({ provider })` — runs the AuthProvider chain, populates `c.get("user")`. Throws `AuthenticationError` on failure.
- `requirePermission(slug)` — enforces against `user.hasPermission(slug)`. Throws `AuthorizationError`. Multiple `requirePermission` middlewares OR within one call, AND across calls.
- Public routes (callbacks, health) skip the auth chain entirely.

## Validation

- `validate("json" | "query" | "param" | "header", schema)` — Zod schema goes through `zValidator`; `c.req.valid(target)` reads parsed input. Lint rule `no-restricted-syntax` flags raw `c.req.json/query/param`.
- Schemas use Zod 4 (`z.string().uuid()` requires proper v4 version+variant digits).
- `.strict()` on object schemas catches typos in client payloads.

## Errors

- Throw from the AppError taxonomy: `BadRequestError`, `NotFoundError`, `AuthenticationError`, `AuthorizationError`, `ValidationError`, `ConflictError`, `RateLimitError`, `InternalServerError`, `ServiceUnavailableError`.
- `registerErrorHandlers(app)` maps the taxonomy to `{ success: false, error: { code, message, details? } }`. Don't shape error responses inside handlers.

## Services

- Extend `DrizzleEntityService<typeof xxxTable, { xxx: typeof xxxTable }>`.
- Override `getTable()`, `getDefaultSearchFields()`, `getDefaultRelations()` per module.
- Inherit get / getAll / list / count / create / update / delete with soft-delete + audit-column auto-stamping.
- Domain-specific methods (e.g., `findByAccountAndProvider`) live as additional methods on the subclass.

## Schema

- Tables in `modules/<name>/schema.ts` use `pgTable`, spread `...baseFields` for the standard audit columns (`id`, `createdAt`, `updatedAt`, `deletedAt`, `createdBy`, `updatedBy`).
- FKs reference `accounts.id` (the framework's default identity table); cross-module FKs use the pattern `references(() => otherTable.id, { onDelete: "cascade" })`.
- Status fields use `pgEnum` (not text).
- Indexes go in the third arg of `pgTable`: `(table) => [index("name").on(table.col), uniqueIndex(...).on(...)]`. Partial indexes use `.where(sql\`...\`)`.

## Permissions

- Slugs are `module:resource:action` (e.g., `accounts:read`, `oauth:connections:disconnect`, `outbox:drain`).
- Per-action granularity (don't lump admin + read under one slug).
- Export both the slug constants and a `_DEFINITIONS` array with human-readable labels for seeding.

## Environment

- Never read `process.env.*` outside `environment.ts` / `defineEnv()`. Module + consumer code sees env via the validated config object.
- Framework code reads env at boundaries (otel.ts, metrics.ts, defineEnv.ts itself) — those exceptions stay confined.

## Logging

- Use the framework's pino-backed `logger` from `@sixthsummit/ship-api/observability/logger`. Never `console.log` in framework or module code — loses request-id + trace context.
- Per-request scoped loggers come from `c.get("logger")` (set by `httpLogger` middleware).

## Migrations

- v4 uses `drizzle-kit generate`. Never hand-write `src/db/migrations/*.sql` — the next `db:generate` run produces irreproducible state and overwrites your changes.
- Run `npm run db:generate` after any schema edit; review the diff before committing.

## Public API

- Consumers import from `@sixthsummit/ship-api/...` source paths (or the barrel from `@sixthsummit/ship-api`). Never import from `lib/` (build output, no semver guarantee).
- The typed-client lives at `@sixthsummit/ship-api/client` — re-exports `hc` from `hono/client` plus `ShipApiClient<TApp>` and `ShipApiSuccessClient<TApp>` (narrows to success-status 200|201 responses for apps that handle errors centrally). Web + mobile consumers pin their server's `typeof app` and get RPC typing without codegen.

## When in doubt

Read the rule file directly:

- `.cursor/rules/api.mdc` — RESTful design, response formats, security, error handling
- `.cursor/rules/typescript.mdc` — coding standards, type/null safety, DrizzleEntityService patterns
- `.cursor/rules/testing.mdc` — Vitest patterns, mocking, route/service test shapes
- `.cursor/rules/security.mdc` — pluggable AuthProvider, RBAC, permission system
- `.cursor/rules/project-patterns.mdc` — monorepo layout, framework-internal patterns
- `.cursor/rules/commits.mdc` — Conventional Commits + the `ci:` carve-out
- `.cursor/rules/template-development.mdc` — template-authoring rules (`packages/core/templates/default/`)
