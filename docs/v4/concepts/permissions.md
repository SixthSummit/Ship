# Permissions and RBAC

> **Compatibility guide:** this page documents monolithic Hono middleware and
> account tables. New operations declare `authenticated`, `permission`,
> `allPermissions`, or `anyPermission` access policies in the graph.

How the framework's permission system works: slug constants, the `requirePermission` middleware, the role-permission tables the accounts module ships, and the patterns for account-scoped (resource-level) authorization.

## Slug constants

Every permission is a string of the form `module:resource:action` — `accounts:read`, `posts:create`, `billing:invoices:refund`. These are lower-kebab-case, predictable, and seed-able.

The convention every module follows: declare them as a `const` object in `permissions.ts`, plus a parallel definitions array for seeding:

```ts
// src/modules/posts/permissions.ts
export const POSTS_PERMISSIONS = {
  read: "posts:read",
  create: "posts:create",
  update: "posts:update",
  delete: "posts:delete",
  publish: "posts:publish",
} as const;

export const POSTS_PERMISSION_DEFINITIONS = [
  { slug: POSTS_PERMISSIONS.read, label: "View Posts" },
  { slug: POSTS_PERMISSIONS.create, label: "Create Posts" },
  { slug: POSTS_PERMISSIONS.update, label: "Update Posts" },
  { slug: POSTS_PERMISSIONS.delete, label: "Delete Posts" },
  { slug: POSTS_PERMISSIONS.publish, label: "Publish Posts" },
] as const;
```

Routes import the slug; seed scripts import the definitions. Two consumers, one source of truth — typo a slug in one place and TypeScript catches it.

## `requirePermission` — the middleware

```ts
import { requirePermission } from "@sixthsummit/ship-api";

app.post(
  "/posts",
  requireAuth({ provider }),
  requirePermission(POSTS_PERMISSIONS.create),
  validate("json", createPostSchema),
  async (c) => { /* ... */ },
);
```

The signature:

```ts
export function requirePermission(...slugs: string[]): MiddlewareHandler;
```

Pass one slug or many. Multiple slugs are OR-combined within a single `requirePermission()` call — "the user has at least one of these." For AND, chain multiple middleware:

```ts
.post(
  "/posts/:id/publish",
  requireAuth({ provider }),
  requirePermission(POSTS_PERMISSIONS.update),
  requirePermission(POSTS_PERMISSIONS.publish),
  // user needs BOTH posts:update AND posts:publish
  /* ... */
)
```

The middleware:

1. Reads `c.var.user` (set by `requireAuth`). Throws `AuthorizationError` if missing — `requirePermission` always requires `requireAuth` first.
2. Calls `user.hasPermission(slug)` for each slug, in order.
3. If any returns `true`, calls `next()`.
4. If all return `false`, throws `AuthorizationError`.

The middleware tags itself with `PERMISSION_META`. `createApp`'s interceptor records the slug list in the route registry's `permissions` field, so MCP introspection and `/dev/routes` show which permissions each route requires.

## How permissions get evaluated

`AuthenticatedAccount.hasPermission(slug)` is the contract. The default Firebase + accounts wiring resolves permissions through a role: the account has a `roleId`, the role has a `role_permissions` join, the join points to `permissions`. The `hasPermission` implementation queries (with caching) for the account's role's permissions and checks for the slug.

The accounts module's schema:

```ts
// src/modules/accounts/schema.ts
export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),  // Durable identifier
  name: varchar("name", { length: 200 }).notNull(),           // Human label
  ...baseFields,
});

export const rolePermissions = pgTable("role_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  ...baseFields,
});
```

Roles are an explicit table so you can name them ("admin", "editor", "viewer") and group permissions. The single `accounts.roleId` FK gives each account exactly one role — RBAC, not ABAC. If your app needs multi-role accounts, replace the schema (the framework's contract is `hasPermission`; how you compute it is your call).

## Seeding permissions

Permissions need to exist in the database before `requirePermission` can succeed. The pattern is a one-shot seed script that reads the definitions from each module and upserts them:

```ts
import { POSTS_PERMISSION_DEFINITIONS } from "./modules/posts/permissions.js";
import { ACCOUNTS_PERMISSION_DEFINITIONS } from "./modules/accounts/permissions.js";

const allDefinitions = [
  ...ACCOUNTS_PERMISSION_DEFINITIONS,
  ...POSTS_PERMISSION_DEFINITIONS,
];

for (const def of allDefinitions) {
  await db.insert(permissions).values({
    slug: def.slug,
    name: def.label,
  }).onConflictDoUpdate({
    target: permissions.slug,
    set: { name: def.label },
  });
}
```

The seed runs idempotently — `onConflictDoUpdate` on the unique `slug` index. Add it to your boot sequence (a `Seed` bootstrapper at priority 100), an admin endpoint, or a manual `npm run db:seed` script.

## Account-scoped (resource-level) authorization

Slug-based RBAC answers "can this user create posts?" but not "can this user edit *this* post?" The latter needs resource-level checks — typically inside the handler, after the resource is loaded:

```ts
.put(
  "/posts/:id",
  requireAuth({ provider }),
  requirePermission(POSTS_PERMISSIONS.update),
  validate("param", postIdParamSchema),
  validate("json", updatePostSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const post = await postService.get(id);
    if (!post) throw new NotFoundError("Post not found");

    // Resource-level check: only the author can edit
    if (post.authorId !== c.var.user.id) {
      throw new AuthorizationError("Not the post author");
    }

    const updated = await postService.update(id, c.req.valid("json"));
    return c.json(updated);
  },
)
```

Two patterns to know:

**Inline in the handler** — the example above. Best for one-off checks specific to a single endpoint.

**`beforeQuery` lifecycle hook on the service** — for app-wide rules ("users only see their own rows" / "tenant isolation"). The hook sees the active filter and the request context; mutate the filter to scope reads:

```ts
// src/modules/posts/services/PostService.ts
protected override getHooks(): LifecycleHooks {
  return {
    async beforeQuery(filter, ctx) {
      // Multi-tenant: every read scoped to caller's tenant
      const tenantId = await getTenantIdForUser(ctx.userId);
      return { ...filter, tenantId };
    },
  };
}
```

This is the leverage point for tenant isolation — every read on the service scopes correctly without each route handler restating the rule. See [services](services.md) for the full hook set.

## `apiKey` middleware — for service-to-service routes

Some routes shouldn't take a user credential at all — they're called by other services with a static API key. The framework ships `apiKey` middleware:

```ts
import { apiKey } from "@sixthsummit/ship-api";

app.post(
  "/internal/webhooks/stripe",
  apiKey({ header: "X-API-Key" }),
  validate("json", webhookPayloadSchema),
  async (c) => { /* ... */ },
);
```

The middleware reads the configured header, compares constant-time against `ADMIN_API_KEY` (or whatever env-validated key you've configured), throws `AuthenticationError` on mismatch. No `requireAuth`, no `requirePermission` — service-to-service routes are gated by the key, not by user identity.

## Common patterns

**Public read, protected write:**

```ts
.get("/posts", validate("query", listSchema), handler)               // no auth
.post("/posts", requireAuth({ provider }), requirePermission(...), handler)
```

**Optional auth (different response by user):**

```ts
const optionalAuth = requireAuth({ provider, optional: true });

app.get("/posts/:id", optionalAuth, async (c) => {
  const post = await postService.get(c.req.param("id"));
  if (post.published) return c.json(post);
  // Unpublished posts visible only to the author
  if (c.var.user?.id !== post.authorId) throw new NotFoundError("...");
  return c.json(post);
});
```

**Per-permission rate limit** (Phase B feature, for context):

```ts
.delete(
  "/posts/:id",
  requireAuth({ provider }),
  requirePermission(POSTS_PERMISSIONS.delete),
  rateLimit({ windowMs: 60_000, max: 10, scope: "user" }),
  handler,
)
```

## Source

- [`packages/core/src/http/middleware/requirePermission.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/requirePermission.ts) — the middleware
- [`packages/core/src/http/middleware/apiKey.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/middleware/apiKey.ts) — service-to-service auth
- [`modules/accounts/schema.ts`](https://github.com/sixthsummit/ship-api/blob/main/modules/accounts/schema.ts) — `permissions`, `role_permissions`, and `roles` tables
- [`modules/accounts/permissions.ts`](https://github.com/sixthsummit/ship-api/blob/main/modules/accounts/permissions.ts) — canonical slug-constants pattern
- [`.cursor/rules/security.mdc`](https://github.com/sixthsummit/ship-api/blob/main/.cursor/rules/security.mdc) — RBAC and account-scoped conventions
