# Database and migrations

> **Compatibility guide:** this page documents the monolithic pool, service, and
> migration conventions. New operation applications expose narrow repository
> capabilities through `@sixthsummit/ship-drizzle` unit-of-work providers.

The Drizzle pool, the `baseFields` audit-column mixin, the `withTransaction` wrapper, the migration workflow (and the never-write-SQL-by-hand rule the Claude plugin enforces), and the identity tables the accounts module ships.

## The Drizzle pool

The framework owns pool creation. `createApp({ schema })` wires up the pool from your env (`DATABASE_URL`), parameterizes Drizzle by the schema, and exposes the resulting `db` to bootstrappers and modules through the bootstrap context.

Under the hood:

```ts
// packages/core/src/app/db/client.ts
export interface DbConfig {
  connectionString?: string;          // postgres://...
  host?: string; port?: number; database?: string; user?: string; password?: string;
  max?: number;                       // default 20
  idleTimeoutMillis?: number;         // default 30_000
  connectionTimeoutMillis?: number;   // default 5_000
  statementTimeoutMillis?: number;    // default 30_000 (0 to disable)
  applicationName?: string;
}

export function createPool(config: DbConfig): pg.Pool;
export function createDb<TSchema>(args: {
  config: DbConfig;
  schema: TSchema;
  pool?: pg.Pool;
}): { pool: pg.Pool; db: NodePgDatabase<TSchema> };
```

The `statementTimeoutMillis` is applied on every connection checkout (`pool.on('connect', ...)`), so it works even when you pass in a pre-existing pool — the framework doesn't trust connection-level state.

## `baseFields` — audit columns

Every table that represents domain data spreads `baseFields` to inherit the framework's audit columns:

```ts
// packages/core/src/app/db/baseFields.ts
export const baseFields = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),    // auto-updates on row mutation
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // nullable; soft-delete marker
  createdBy: uuid("created_by"),     // nullable; actor id
  updatedBy: uuid("updated_by"),     // nullable; actor id
} as const;
```

In a table definition:

```ts
export const posts = pgTable("posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...baseFields,
});
```

The columns are:

- **`createdAt`** — set automatically on insert (`default now()`)
- **`updatedAt`** — set automatically on insert and bumped automatically on every update (`$onUpdate` callback)
- **`deletedAt`** — nullable. When set, the row is treated as soft-deleted and filtered out of every read by default
- **`createdBy`** / **`updatedBy`** — nullable UUID columns. `DrizzleEntityService` stamps these from `RequestContext.userId` (the verified auth claim's `subject`) on every create / update

> **`createdBy`/`updatedBy` stamping requires the request-context middleware.** `RequestContext` is an `AsyncLocalStorage` that `httpLogger()` establishes per request; `requireAuth({ provider })` then writes `userId` into it. If `httpLogger()` isn't wired (`app.use("*", httpLogger())` — the reference template does this by default), there's no active context, `setRequestContextField` is a no-op, and `createdBy`/`updatedBy` stay `null`. Writes outside a request (seed scripts, cron) have no context either — that's expected; stamp explicitly there if you need attribution.

Soft-delete is applied opportunistically by `DrizzleEntityService.delete()` — if the table has `deletedAt`, it's set to `now()` and `updatedBy` is stamped; otherwise it's a hard `DELETE`. To bypass the soft-delete filter on a read, pass `includeDeleted: true` in `QueryOptions`.

There's also `baseFieldsTimestampsOnly` for system tables (rate-limit logs, idempotency cache) where actor attribution is meaningless — it omits `createdBy` and `updatedBy`.

## `withTransaction` — atomic multi-write

For operations that need to span multiple writes:

```ts
import { withTransaction } from "@sixthsummit/ship-api/app/db/transaction";

await withTransaction(db, async (tx) => {
  const post = await postService.create(input);
  await db.insert(audit).values({ postId: post.id, action: "created" });
  return post;
});
```

The wrapper:

- Opens a Drizzle transaction
- Wraps it in an OpenTelemetry span named `db.transaction`
- Translates Drizzle's `TransactionRollbackError` into the framework's `RollbackError` (so consumers can `instanceof RollbackError` cleanly)
- Optionally retries on Postgres deadlock SQLSTATEs (`40001` serialization failure, `40P01` deadlock detected) — pass `{ retryOnConflict: { attempts: 3, backoffMs: 50 } }`
- Propagates the active transaction client through `RequestContext.tx`, so `DrizzleEntityService` lifecycle hooks know they're inside a transaction

Signature:

```ts
export async function withTransaction<TSchema, T>(
  db: NodePgDatabase<TSchema>,
  fn: (tx: ShipTx<TSchema>) => Promise<T>,
  opts?: {
    retryOnConflict?: { attempts: number; backoffMs: number };
    spanName?: string;
  },
): Promise<T>;
```

Two patterns to know:

**Don't enqueue BullMQ jobs inside a transaction.** A worker can pick the job up before the transaction commits and query for a row that doesn't exist yet. Use the outbox pattern instead — `OutboxEventEmitter.emit({...}, { tx })` writes the event to an outbox table inside the transaction; a separate drainer publishes events that committed. See [`modules/outbox/`](https://github.com/sixthsummit/ship-api/tree/main/modules/outbox) for the full implementation.

**Lifecycle hooks see the transaction.** When you call `service.create()` from inside `withTransaction`, the hook context's `tx` is set. Hooks can use it to make additional writes that commit atomically with the original.

## The migration workflow

ShipAPI uses Drizzle Kit. The flow is one-way: schema source is canonical; SQL is generated.

```sh
# 1. Edit src/db/schema.ts — add a column, change a type, drop a table
# 2. Generate the migration:
npm run db:generate -- --name add_published_at_to_posts
# 3. Drizzle Kit writes src/db/migrations/<timestamp>_add_published_at_to_posts.sql
# 4. Review the diff in your PR
# 5. Apply migrations on deploy (npm run db:migrate, or your CI pipeline)
```

The contract:

> **Never edit migration SQL by hand.** Edit the schema source and regenerate. The Claude plugin's PreToolUse hook (`block-migration-edit.sh`) blocks Edit/Write to `src/db/migrations/*.sql` on agent runs; the convention applies to humans too.

Hand-editing breaks reproducibility — the next `db:generate` writes a fresh diff against the current schema, and your hand-edited file is now an orphan that contradicts the schema source. If you need a manual SQL operation that Drizzle's diff doesn't generate (custom indexes, materialized views, raw triggers), put it in a separate, hand-named migration file and don't regenerate that one.

The `drizzle.config.ts` the template ships:

```ts
import { defineConfig } from "drizzle-kit";
import { env } from "./src/environment.js";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: env.DATABASE_URL },
  verbose: true,                      // detailed diff output for PR review
  strict: true,                       // prompt on destructive operations
});
```

`verbose: true` makes the diff readable. `strict: true` makes Drizzle Kit prompt before destructive changes (column drops, type narrows) — useful as a guardrail when the schema diff isn't what you expected.

### Applying migrations

The framework doesn't prescribe *when* migrations apply. Two common patterns:

**Auto-apply on boot** — register a bootstrapper that runs `migrate(db, { migrationsFolder: "./src/db/migrations" })` at priority 25 (after `InitDatabase`, before any module). Simple for small / single-replica deployments.

**Separate `db:migrate` script** — run as a CI step before deploying, or as an init container before pod rollout. Preferred for production / multi-replica deployments where you don't want the racing-replica problem (two pods both trying to migrate at once).

The default template ships with the script wired but commented; pick the pattern that fits your deploy and uncomment.

## The accounts module's identity tables

The framework no longer ships a default schema. Identity/RBAC tables live in the **accounts module** (added to your app via `ship-api add accounts`, which copies it to `src/modules/accounts/`). The module exports an `accountsSchema` fragment bundling these tables:

```ts
// src/modules/accounts/schema.ts
export const accountsSchema = {
  accounts, accountsRelations,
  roles, rolesRelations,
  permissions, permissionsRelations,
  rolePermissions, rolePermissionsRelations,
  refreshTokens, refreshTokensRelations,
};
```

| Table | Purpose |
| --- | --- |
| `accounts` | The user account. `firebaseUid`, `email` (unique), `displayName`, `isActive`, `roleId` FK, plus baseFields. |
| `roles` | Named roles (`admin`, `editor`, `viewer`). Each account has at most one role via `accounts.roleId`. |
| `permissions` | Catalog of slug-named permissions (`accounts:read`, etc.). Seeded from module `*_PERMISSION_DEFINITIONS`. |
| `role_permissions` | Many-to-many join between roles and permissions. |
| `refresh_tokens` | Hashed refresh tokens for the JWT cookie-auth flow. Holds `tokenHash` (SHA-256), expiry, replacement chain links. |

Compose them with your own:

```ts
import { accountsSchema } from "./modules/accounts";
import { posts, postsRelations } from "./modules/posts/schema.js";

export const schema = {
  ...accountsSchema,
  posts,
  postsRelations,
};

const app = createApp({ schema });
```

If you're not using the framework's auth wiring (custom provider, no JWT cookies), drop the tables you don't need by spreading selectively:

```ts
const { refreshTokens, refreshTokensRelations, ...minimal } = accountsSchema;
const schema = { ...minimal, posts };
```

You'd want to also generate a migration that drops the unused tables — a one-time cleanup.

## Connection pooling and `pg`

The pool is `pg.Pool` from node-postgres. Defaults are tuned for typical web workloads (max 20 connections, 30s idle, 5s connection timeout, 30s statement timeout). Adjust via the env or by passing `DbConfig` directly to a custom bootstrap. For high-write workloads, consider raising `max`; for serverless / Cloud Run with cold starts, consider lower `max` to avoid pool starvation when the platform recycles instances.

The framework intentionally doesn't ship a connection-pool-per-request pattern. Modern Postgres (with PgBouncer or RDS Proxy in front) handles connection pooling externally; the in-process pool is sized for the worker's concurrency, not for the workload's total parallelism.

## Source

- [`packages/core/src/app/db/client.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/db/client.ts) — pool creation
- [`packages/core/src/app/db/baseFields.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/db/baseFields.ts) — audit columns
- [`packages/core/src/app/db/transaction.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/db/transaction.ts) — `withTransaction` and `RollbackError`
- [`modules/accounts/schema.ts`](https://github.com/sixthsummit/ship-api/blob/main/modules/accounts/schema.ts) — identity tables + `accountsSchema` fragment
- [`packages/claude-plugin/hooks/block-migration-edit.sh`](https://github.com/sixthsummit/ship-api/blob/main/packages/claude-plugin/hooks/block-migration-edit.sh) — the never-edit-SQL enforcement
- [`.cursor/rules/api.mdc`](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/api.mdc) — migration conventions
