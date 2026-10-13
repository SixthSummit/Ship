# Services and DrizzleEntityService

> **Compatibility guide:** `DrizzleEntityService` remains supported for current
> v4 applications. It is not the new default. Operation applications depend on
> small explicit repository capabilities and transaction-scoped unit-of-work
> providers.

`DrizzleEntityService<TTable>` is the framework's generic CRUD/list/search base. Every feature module's service extends it. This page covers what you get for free, the lifecycle hooks for inserting custom behavior, the neutral `QueryOptions` DSL, and the worked example from `modules/accounts/`.

## What `DrizzleEntityService` does for you

A subclass that does nothing more than `getTable()` already has:

- **`get(id, opts?)`** — fetch one row by primary key, optionally with relations loaded
- **`getAll(opts?)`** — fetch matching rows as an array
- **`list(opts?)`** — fetch matching rows + total count, in one round-trip-ish (`{ rows, total }`)
- **`count(opts?)`** — count of matching rows
- **`create(values)`** — insert with audit-column stamping (`createdBy` from `RequestContext.userId`), `applyOptionalFields` for defaults, `resolveRelationIds` for FK refs, and `beforeCreate` / `afterCreate` hooks
- **`update(id, patch)`** — load previous, run `beforeUpdate(prev, patch)`, write, run `afterUpdate(prev, next)`
- **`delete(id)`** — soft-delete (set `deletedAt` to now) when the table has a `deletedAt` column; hard delete otherwise. `beforeDelete` / `afterDelete` hooks fire either way.

Soft-deleted rows are filtered out of every read by default; pass `includeDeleted: true` in `QueryOptions` to bypass. Audit columns are stamped from the request context — see [database](database.md) for `baseFields` and the audit-column contract.

## A minimal service

```ts
import { DrizzleEntityService } from "@sixthsummit/ship-api";
import { posts } from "../schema.js";

export class PostService extends DrizzleEntityService<typeof posts> {
  protected getTable() {
    return posts;
  }
}
```

That's a complete service. It has CRUD, soft-delete, audit stamping, and exposes the methods every consumer needs. The route layer uses it via dependency injection:

```ts
const postService = new PostService(db);
const app = root.route("/", buildPostsApp({ service: postService, provider }));
```

## Customizing default behavior

Most modules override one or more of these:

```ts
// Override what fields the ?search= free-text query scans
protected override getDefaultSearchFields(): readonly string[] {
  return ["title", "body"];
}

// Override what relations get eager-loaded
protected override getDefaultRelations(): readonly string[] {
  return ["author", "tags"];
}

// Override the default ORDER BY
protected override getDefaultOrder(): readonly OrderClause[] {
  return [{ field: "publishedAt", direction: "desc", nulls: "last" }];
}
```

These read like configuration but they're per-module — the same `DrizzleEntityService` base across the framework adapts to each module by override.

## Lifecycle hooks

Hooks let you insert behavior into the CRUD flow without overriding the public methods. Two ways to register them:

**Per-service** by overriding `getHooks()`:

```ts
protected override getHooks(): LifecycleHooks {
  return {
    async beforeCreate(values, ctx) {
      // ctx.userId, ctx.tx
      values.slug = slugify(values.title);
      return values;
    },
    async afterCreate(row, ctx) {
      logger.info({ postId: row.id, userId: ctx.userId }, "post.created");
    },
  };
}
```

**Composed across multiple sets** with `composeHooks(set1, set2, ...)`:

```ts
protected override getHooks(): LifecycleHooks {
  return composeHooks(
    auditHooks,                  // emits audit events
    cacheInvalidationHooks,      // invalidates relevant cache keys
    domainSpecificHooks,         // module-specific behavior
  );
}
```

`composeHooks` runs `before*` hooks FIFO (audit, then cache, then domain) and `after*` hooks LIFO (domain, then cache, then audit). The asymmetry mirrors typical use: pre-write you want generic concerns to set context first; post-write you want domain logic to settle before generic side effects fire.

The full hook set:

```ts
export interface LifecycleHooks<TRow, TInsert, TPatch> {
  beforeCreate?(values: TInsert, ctx: LifecycleHookContext): Promise<TInsert | void> | TInsert | void;
  afterCreate?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  beforeUpdate?(prev: TRow, patch: TPatch, ctx: LifecycleHookContext): Promise<TPatch | void> | TPatch | void;
  afterUpdate?(prev: TRow, next: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  beforeDelete?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;
  afterDelete?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  beforeQuery?(filter: QueryFilter, ctx: LifecycleHookContext): Promise<QueryFilter | void> | QueryFilter | void;
}
```

`LifecycleHookContext` carries the request context: `userId` (from the verified auth claim), `tx` (the active transaction client when one is open; otherwise `undefined`).

When a hook returns a value (e.g., `beforeCreate` returns the modified `values`), the next step uses that value. When it returns `void`, the original passes through unchanged. This shape lets hooks be composable — each one transforms-or-not without coordinating with the others.

`beforeQuery` is the leverage point for row-level access control. A multi-tenant app, for instance, can attach a hook that reads `ctx.userId`, looks up the tenant id, and adds `tenantId: <id>` to the filter. Every read on the service then scopes correctly without each route handler restating the rule.

## The `QueryOptions` DSL

Read methods accept a `QueryOptions` object — a neutral, ORM-independent operator DSL:

```ts
const result = await postService.list({
  where: {
    published: true,
    publishedAt: { gte: lastWeek, lt: now },
    title: { ilike: "%hono%" },
  },
  search: "drizzle",                         // free-text across getDefaultSearchFields()
  relations: ["author"],                     // override getDefaultRelations()
  order: [{ field: "publishedAt", direction: "desc" }],
  limit: 20,
  offset: 0,
});
// result: { rows: Post[]; total: number }
```

The full operator set:

| Operator | Meaning |
| --- | --- |
| `eq` | Equal (shorthand: bare value, e.g. `{ published: true }`) |
| `ne` | Not equal |
| `gt`, `gte`, `lt`, `lte` | Comparison |
| `in` | Value is one of an array |
| `like` | SQL `LIKE` (case-sensitive; `%` and `_` wildcards) |
| `ilike` | Case-insensitive `LIKE` (Postgres `ILIKE`) |
| `isNull` | `true` → IS NULL, `false` → IS NOT NULL |

Per-column operators are AND-combined. Columns are AND-combined. There's no built-in OR — for that, drop to a custom service method that calls Drizzle directly. The DSL deliberately doesn't try to be a complete ORM-translation layer; it covers the 80% of read patterns that every CRUD route needs and gets out of the way for the rest.

`QueryOptions` is generic over the row type, so when you read it from a Drizzle table the field names and value types are inferred:

```ts
QueryOptions<typeof posts.$inferSelect, "author" | "tags">
//          ^^^ row type — title, body, publishedAt, etc.
//                                       ^^^ relation keys
```

This means TypeScript catches `where: { titel: "..." }` (typo) and `where: { publishedAt: "yesterday" }` (wrong type) at compile time.

## A worked example: `accounts`

The framework's own `accounts` module is the canonical reference for a CRUD-shaped service. Three files matter:

**`schema.ts`** — the table:

```ts
import { pgTable, uuid, varchar, boolean } from "drizzle-orm/pg-core";
import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
import { roles } from "../roles/schema.js";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  firebaseUid: varchar("firebase_uid", { length: 128 }),
  email: varchar("email", { length: 320 }).notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  displayName: varchar("display_name", { length: 200 }),
  isActive: boolean("is_active").notNull().default(true),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  ...baseFields,
}, (table) => [
  uniqueIndex("accounts_email_unique").on(table.email),
  uniqueIndex("accounts_firebase_uid_unique").on(table.firebaseUid),
]);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
```

**`services/AccountService.ts`** — the service:

```ts
export class AccountService extends DrizzleEntityService<typeof accounts> {
  protected getTable() {
    return accounts;
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return ["email", "displayName"];
  }

  protected override getDefaultRelations(): readonly string[] {
    return ["role"];
  }
}
```

**`routes.ts`** — the routes (excerpt):

```ts
.get(
  "/accounts/list",
  auth,
  requirePermission(ACCOUNTS_PERMISSIONS.read),
  validate("query", listAccountsQuerySchema),
  async (c) => {
    const q = c.req.valid("query");
    const offset = (q.page - 1) * q.perPage;
    const result = await deps.service.list({
      search: q.search,
      where: filterFromQuery(q),
      limit: q.perPage,
      offset,
    });
    return c.json({ ...result, page: q.page, perPage: q.perPage }, 200);
  },
)
```

That's the full pattern. Schema → service → routes; no controller layer, no DTO mapping, no inheritance hierarchy beyond the one class. Read [`modules/accounts/`](https://github.com/sixthsummit/ship-api/tree/main/modules/accounts) end-to-end before designing your own non-trivial service.

## When the base class isn't enough

Sometimes a service needs operations that don't fit CRUD. Add domain methods alongside the inherited ones:

```ts
export class PostService extends DrizzleEntityService<typeof posts> {
  protected getTable() {
    return posts;
  }

  /** Publish a draft post. Atomic with the audit row write. */
  async publish(id: string, ctx: { userId: string }): Promise<Post> {
    return withTransaction(this.db, async (tx) => {
      const post = await this.update(id, { published: true, publishedAt: new Date() });
      await tx.insert(publishAudit).values({
        postId: id,
        publishedBy: ctx.userId,
      });
      return post;
    });
  }
}
```

A few patterns worth noting:

- **`withTransaction(db, fn)` for atomicity.** See [database](database.md) for the transaction wrapper, retry-on-deadlock support, and the `RequestContext.tx` propagation that makes lifecycle hooks aware of the active transaction.
- **Don't enqueue BullMQ jobs inside a transaction.** A worker can pick the job up before the transaction commits and query for a row that doesn't exist yet. Use the outbox pattern (`OutboxEventEmitter.emit({...}, { tx })`) — covered in the upcoming jobs page.
- **Domain methods take a `ctx` parameter for actor info.** The base class reads `RequestContext` automatically; explicit ctx is the convention for domain methods so the call site is unambiguous.

## Source

- [`packages/core/src/app/services/DrizzleEntityService.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/DrizzleEntityService.ts) — the base class
- [`packages/core/src/app/services/LifecycleHooks.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/services/LifecycleHooks.ts) — hook types and `composeHooks`
- [`packages/core/src/app/db/QueryOptions.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/app/db/QueryOptions.ts) — the operator DSL
- [`modules/accounts/`](https://github.com/sixthsummit/ship-api/tree/main/modules/accounts) — canonical CRUD reference
- [`modules/outbox/`](https://github.com/sixthsummit/ship-api/tree/main/modules/outbox) — non-CRUD service example (transactional outbox + drainer)
