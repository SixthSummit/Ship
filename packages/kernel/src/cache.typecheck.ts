/** Type-level CI contract for declared read caching and tag invalidation. */
import { z } from "zod";
import { authenticatedAccess } from "./access.js";
import { operationActor } from "./actor.js";
import { type CacheBackend, cacheBackendDependency } from "./cache.js";
import { unitOfWorkDependency } from "./dependency.js";
import { defineOperation } from "./operation.js";
import { createTenantScopeAuthority } from "./tenant.js";

const cache = cacheBackendDependency("platform.cache");
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(): void } }>("database.primary");
const tenants = createTenantScopeAuthority({ id: "app.tenants", authorize: () => true });

cache.scope satisfies "cache";
({}) as unknown as CacheBackend satisfies { readonly kind: "ship.cache-backend" };

const read = defineOperation({
  id: "widgets.list",
  input: { query: z.object({ limit: z.coerce.number().int() }) },
  output: { 200: z.object({ total: z.number() }) },
  successStatus: 200,
  errors: [],
  access: authenticatedAccess(),
  transaction: "read",
  dependencies: { cache, tx: unitOfWork },
  cache: {
    ttlMs: 30_000,
    scope: "tenant",
    tags: ["widgets"],
    // vary receives the validated input, not the raw request shape.
    vary: (input) => [`limit:${input.query.limit.toFixed(0)}`],
    tenant: ({ input, context }) =>
      tenants.issue({
        tenantId: `${input.query.limit}`,
        requestId: context.requestId,
        actor: context.actor ?? operationActor({ id: "anonymous" }),
      }),
  },
  handler: () => ({ total: 1 }),
});
read.cache?.scope satisfies "actor" | "tenant" | "public" | undefined;

defineOperation({
  id: "widgets.vary-input",
  input: { query: z.object({ limit: z.coerce.number().int() }) },
  output: { 200: z.object({ total: z.number() }) },
  successStatus: 200,
  errors: [],
  access: authenticatedAccess(),
  transaction: "none",
  dependencies: { cache },
  cache: {
    ttlMs: 1_000,
    scope: "actor",
    // @ts-expect-error vary sees validated input, so a missing key is a type error
    vary: (input) => [input.query.missing],
  },
  handler: () => ({ total: 1 }),
});

defineOperation({
  id: "widgets.bad-scope",
  input: {},
  output: { 200: z.object({ total: z.number() }) },
  successStatus: 200,
  errors: [],
  access: authenticatedAccess(),
  transaction: "none",
  dependencies: { cache },
  // @ts-expect-error only actor, tenant and public scopes exist
  cache: { ttlMs: 1_000, scope: "session" },
  handler: () => ({ total: 1 }),
});

defineOperation({
  id: "widgets.rename",
  input: { body: z.object({ name: z.string() }) },
  output: { 200: z.object({ renamed: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: authenticatedAccess(),
  transaction: "write",
  dependencies: { tx: unitOfWork },
  invalidates: ["widgets"],
  handler: () => ({ renamed: true as const }),
});

defineOperation({
  id: "widgets.bad-invalidates",
  input: {},
  output: { 200: z.object({ renamed: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: authenticatedAccess(),
  transaction: "write",
  dependencies: { tx: unitOfWork },
  // @ts-expect-error invalidates names tags, not objects
  invalidates: [{ tag: "widgets" }],
  handler: () => ({ renamed: true as const }),
});
