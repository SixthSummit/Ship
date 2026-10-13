/**
 * Permission slugs for the accounts module.
 *
 * v3 exported `Permission` entity instances; v4 exports plain string
 * constants because authorization is enforced by `requirePermission(slug)`
 * middleware at the route, not by `@HasPermission` decorators on a
 * controller method. The Permission DB rows themselves are seeded by
 * the consuming app (typically in a custom bootstrapper) — the module
 * declares the *names* it expects to exist.
 */

import type { PermissionDefinition } from "@sixthsummit/ship-api";

export const ACCOUNTS_PERMISSIONS = {
  read: "accounts:read",
  create: "accounts:create",
  update: "accounts:update",
  delete: "accounts:delete",
} as const;

export type AccountsPermission = (typeof ACCOUNTS_PERMISSIONS)[keyof typeof ACCOUNTS_PERMISSIONS];

/**
 * The list form is what a seed script feeds to the Permission table.
 * Each entry pairs the slug with a human-readable label that surfaces
 * in admin UIs when assigning permissions to roles.
 */
export const ACCOUNTS_PERMISSION_DEFINITIONS = [
  { slug: ACCOUNTS_PERMISSIONS.read, label: "View Accounts" },
  { slug: ACCOUNTS_PERMISSIONS.create, label: "Create Accounts" },
  { slug: ACCOUNTS_PERMISSIONS.update, label: "Update Accounts" },
  { slug: ACCOUNTS_PERMISSIONS.delete, label: "Delete Accounts" },
] as const satisfies readonly PermissionDefinition[];
