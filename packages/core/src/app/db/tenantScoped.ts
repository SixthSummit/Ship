import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { uuid } from "drizzle-orm/pg-core";

/**
 * `tenantScoped(tenants)` — opt-in multi-tenancy column primitive, the sibling
 * of `baseFields`.
 *
 * Tenancy is never a core default. A multi-tenant product spreads this mixin
 * into the domain tables it wants scoped; a single-tenant product simply never
 * uses it. Core ships the *shape* — a non-null `tenant_id` uuid foreign key to a
 * `tenants` root table, `onDelete: "restrict"` so a tenant can't be deleted out
 * from under its rows — but forces nothing: the `tenants` table is
 * consumer-owned, so this is a *factory* that takes it, rather than a static
 * object referencing a table core doesn't have.
 *
 * Conventions (see `docs/v4/concepts/tenancy.md`):
 *   - Domain tables FK `tenants`, NOT `accounts` — so a future
 *     one-tenant-per-user → membership move (Model A → B) is an
 *     identity-tables-only migration.
 *   - Read the active tenant from `RequestContext.tenantId` (published by
 *     `resolveTenant()`), never from `account.tenantId` directly.
 *   - Index `tenant_id` leading on scoped tables — usually
 *     `(tenant_id, <natural key>)`.
 *
 * Usage:
 *
 * ```ts
 * import { index, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
 * import { baseFields, tenantScoped } from "@sixthsummit/ship-api";
 * import { tenants } from "../accounts/schema.js";
 *
 * export const projects = pgTable(
 *   "projects",
 *   {
 *     id: uuid("id").primaryKey().defaultRandom(),
 *     name: varchar("name", { length: 200 }).notNull(),
 *     ...tenantScoped(tenants), // adds a non-null tenant_id FK → tenants.id
 *     ...baseFields,
 *   },
 *   (t) => [index("projects_tenant_ix").on(t.tenantId)],
 * );
 * ```
 *
 * Tenant *enforcement* — auto-injecting `WHERE tenant_id = ?` on every query via
 * the `beforeQuery` lifecycle hook + `RequestContext.tenantId` — is deliberately
 * deferred (see `V4_STATUS` V8). This primitive ships only the column shape and
 * the resolution convention; it scopes nothing on its own.
 */
export function tenantScoped<TTenants extends { id: AnyPgColumn }>(tenants: TTenants) {
  return {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
  } as const;
}

/**
 * Row-shape contribution of `tenantScoped` (for service-level type
 * constraints), mirroring `BaseFields`.
 */
export type TenantScoped = {
  tenantId: string;
};
