import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";
import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Identity + RBAC schema for the accounts module.
 *
 * Relocated out of framework core (`@sixthsummit/ship-api/app/schema/*`) so the
 * framework stays incrementally adoptable and each product owns / tailors its
 * identity model (multi-tenant or not). Core ships the primitives — `baseFields`,
 * the `AuthProvider` interface, `DrizzleEntityService`; this module owns the
 * concrete tables.
 *
 * Spread `accountsSchema` into `createApp({ schema })` (and the test-DB harness)
 * the way the old core `defaultSchema` was.
 */

/**
 * `tenants` — opt-in multi-tenancy root table (A2-1).
 *
 * Tenancy is a per-product choice. This table + the `tenantsSchema` fragment
 * ship with the accounts module but are NOT part of the default `accountsSchema`
 * — a single-tenant product never composes them and never sees a `tenants`
 * table. A multi-tenant product:
 *   1. composes `tenantsSchema` into `createApp({ schema })`,
 *   2. applies `...tenantScoped(tenants)` to the domain tables it wants scoped
 *      (and, for the one-tenant-per-account default, to `accounts` — see the
 *      commented field below),
 *   3. wires `resolveTenant()` after `requireAuth`.
 *
 * Domain tables FK `tenants`, not `accounts`, so a future move to a membership
 * model (Model A → B) is an identity-tables-only migration. See
 * `docs/v4/concepts/tenancy.md`.
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  ...baseFields,
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * Opt-in tenancy schema fragment — compose alongside `accountsSchema` when a
 * product enables multi-tenancy:
 * `createApp({ schema: { ...accountsSchema, ...tenantsSchema, ...domainTables } })`.
 * Kept separate from `accountsSchema` so single-tenant products never get a
 * `tenants` table.
 */
export const tenantsSchema = {
  tenants,
} as const;

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: varchar("description", { length: 500 }),
  ...baseFields,
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  ...baseFields,
});

export const rolePermissions = pgTable("role_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "cascade" }),
  permissionId: uuid("permission_id")
    .notNull()
    .references(() => permissions.id, { onDelete: "cascade" }),
  ...baseFields,
});

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Stable subject identifier from the auth provider (Firebase UID by default;
     * `sub` claim under any other `AuthProvider` adapter).
     */
    firebaseUid: varchar("firebase_uid", { length: 128 }),

    email: varchar("email", { length: 320 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),

    displayName: varchar("display_name", { length: 200 }),

    /** Soft-disable without deleting (distinct from `deletedAt`). */
    isActive: boolean("is_active").notNull().default(true),

    /** Optional FK to a single primary role. Multi-role assignments are
     *  modeled in a join table by consumers who need them. */
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),

    // ─── Multi-tenancy (opt-in, A2-1) ────────────────────────────────
    // Uncomment for the one-tenant-per-account model: adds a non-null
    // `tenant_id` uuid FK → tenants.id. Then compose `tenantsSchema` into your
    // app schema and wire `resolveTenant()` after `requireAuth`. Import the
    // mixin from the barrel: `import { tenantScoped } from "@sixthsummit/ship-api"`.
    // ...tenantScoped(tenants),

    ...baseFields,
  },
  (table) => [
    uniqueIndex("accounts_email_unique").on(table.email),
    uniqueIndex("accounts_firebase_uid_unique").on(table.firebaseUid),
  ],
);

export const rolesRelations = relations(roles, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, {
    fields: [rolePermissions.roleId],
    references: [roles.id],
  }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  role: one(roles, {
    fields: [accounts.roleId],
    references: [roles.id],
  }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;

/**
 * `refresh_tokens` — server-side store for the JWT-cookie auth refresh-token
 * rotation flow. `tokenHash` is a SHA-256 of the token (never the raw value);
 * `revokedAt` supports immediate server-side revocation; `replacedById` tracks
 * rotation history so refresh-token reuse (a theft signal) can revoke the whole
 * chain. Consumed by the framework's generic `DrizzleRefreshTokenStore`, which
 * takes this table via its constructor.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"),
    /** User-agent / IP on issue, for audit + risk signals. */
    userAgent: varchar("user_agent", { length: 500 }),
    issuedFromIp: varchar("issued_from_ip", { length: 64 }),
    ...baseFields,
  },
  (table) => [
    index("refresh_tokens_account_id_idx").on(table.accountId),
    index("refresh_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  account: one(accounts, {
    fields: [refreshTokens.accountId],
    references: [accounts.id],
  }),
}));

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

/**
 * Composable schema fragment — spread into `createApp({ schema })` and the
 * integration-test DB harness. Replaces this module's slice of the old core
 * `defaultSchema`.
 */
export const accountsSchema = {
  accounts,
  accountsRelations,
  roles,
  rolesRelations,
  permissions,
  permissionsRelations,
  rolePermissions,
  rolePermissionsRelations,
  refreshTokens,
  refreshTokensRelations,
} as const;
