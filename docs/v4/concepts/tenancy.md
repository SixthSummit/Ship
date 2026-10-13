# Multi-tenancy

> **Compatibility guide:** this page documents the earlier column/context
> convention. New work uses typed tenant authority, scoped repository factories,
> and audited privileged bypass from `@sixthsummit/ship-drizzle`.

Tenancy in ShipAPI v4 is an **opt-in primitive**, never a core default. The framework ships the *shape* of multi-tenancy — a `tenantScoped` column mixin, a `tenants` root table in the accounts module, and a request-context resolution convention — but forces nothing. A single-tenant product simply never uses any of it; a multi-tenant product opts in table-by-table.

This page covers the column shape and the resolution convention that ship today. Tenant **enforcement** — auto-injecting `WHERE tenant_id = ?` on every query (Postgres RLS / an `withTenant` ALS guard) — is deliberately deferred (see [`V4_STATUS`](../../V4_STATUS.md) V8). What ships now is the durable, hard-to-change-later half: the column contract every multi-tenant app's database is written against.

## The model: one tenant per account (default)

The default shape is **one tenant per user**: an `accounts.tenantId` non-null FK to a `tenants` root table. Domain tables FK **`tenants`**, never `accounts` — so a future move to a membership model (one user, many tenants — "Model B") is an identity-tables-only migration, invisible to every domain table.

```
tenants ◄──── accounts            (one tenant per account)
   ▲
   └───────── projects, invoices, … (domain tables FK tenants, not accounts)
```

## `tenantScoped` — the column mixin

`tenantScoped(tenants)` is the opt-in sibling of `baseFields`. Spread it into any domain table you want scoped. It contributes a single non-null `tenant_id` uuid FK to your `tenants` table, with `onDelete: "restrict"` so a tenant can't be deleted out from under its rows.

It's a *factory* (not a static object like `baseFields`) because the `tenants` table is yours, not the framework's — you pass it in:

```ts
import { index, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { baseFields, tenantScoped } from "@sixthsummit/ship-api";
import { tenants } from "../accounts/schema.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    ...tenantScoped(tenants), // → non-null tenant_id uuid FK to tenants.id
    ...baseFields,
  },
  // Index tenant_id leading — usually (tenant_id, <natural key>).
  (t) => [index("projects_tenant_ix").on(t.tenantId)],
);
```

## Enabling tenancy in the accounts module

The accounts module ships the `tenants` table and a `tenantsSchema` fragment, but they are **not** part of the default `accountsSchema` — a single-tenant app never composes them and never gets a `tenants` table. To go multi-tenant:

1. **Compose `tenantsSchema`** alongside `accountsSchema`:

   ```ts
   import { accountsSchema, tenantsSchema } from "./modules/accounts/index.js";
   const schema = { ...accountsSchema, ...tenantsSchema, ...yourDomainTables };
   ```

2. **Add `accounts.tenantId`** for the one-tenant-per-account default. The accounts table ships this as a commented line — uncomment it (you own the copied-in module):

   ```ts
   // in modules/accounts/schema.ts, inside the accounts table:
   ...tenantScoped(tenants),
   ```

3. **Wire `resolveTenant()`** after `requireAuth` (next section).

## Resolution convention: read from `RequestContext.tenantId`

The one rule that makes the Model A → B transition cheap: **read the active tenant from `RequestContext.tenantId`, never from `account.tenantId` directly.** The `resolveTenant()` middleware is the single place that bridges the authenticated account to the request context:

```ts
import { requireAuth, resolveTenant } from "@sixthsummit/ship-api";

app.use("*", requireAuth({ provider }));
app.use("*", resolveTenant()); // reads account.tenantId → RequestContext.tenantId
```

Need a different source (a tenant header, a sub-domain, a membership lookup)? Pass a resolver:

```ts
app.use("*", resolveTenant({ resolve: (c) => c.req.header("x-tenant-id") }));
```

Services and handlers then read the active tenant from the request context:

```ts
import { getRequestContext } from "@sixthsummit/ship-api";

const tenantId = getRequestContext()?.tenantId;
```

When membership lands later, you swap the resolver — every downstream read is unchanged.

`RequestContext.userId` follows the same pattern: `requireAuth` publishes the resolved `account.id` to it, which is what `DrizzleEntityService` stamps into `createdBy` / `updatedBy`.

## What's deferred to V8 (enforcement)

A2-1 ships the column shape + resolution convention only. It does **not** auto-scope queries — a service will happily return another tenant's rows unless you filter. Enforcement is the `beforeQuery` lifecycle hook's job (it already documents the intent): a future V8 hook reads `RequestContext.tenantId` and injects `tenant_id = ?` into every query, plus optional Postgres RLS. Until then, scope explicitly in your service's `beforeQuery` or query filters.

## Outbox

`outbox_events.tenant_id` is a nullable `uuid` (reconciled from `text` in A2-1 to match `RequestContext.tenantId` and every other id). It stays nullable because the outbox also carries system/global events with no tenant; there's no FK (the outbox module doesn't own a `tenants` table).

## RBAC stays global

Permission definitions and roles are global — not per-tenant — in v4. Per-tenant roles are a cheap, non-breaking nullable `roles.tenantId` add later if a product needs them; they're intentionally not part of A2-1.
