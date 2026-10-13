/**
 * Permission slugs for the {{namePlural}} module.
 *
 * Authorization runs at the route via `requirePermission(slug)` middleware.
 * The Permission DB rows themselves are seeded by the consuming app
 * (typically a custom bootstrapper) — this file declares the *names*.
 */

export const {{NAME_PLURAL}}_PERMISSIONS = {
  read: "{{namePlural}}:read",
  create: "{{namePlural}}:create",
  update: "{{namePlural}}:update",
  delete: "{{namePlural}}:delete",
} as const;

export type {{NamePlural}}Permission =
  (typeof {{NAME_PLURAL}}_PERMISSIONS)[keyof typeof {{NAME_PLURAL}}_PERMISSIONS];

export const {{NAME_PLURAL}}_PERMISSION_DEFINITIONS = [
  { slug: {{NAME_PLURAL}}_PERMISSIONS.read, label: "View {{NamePlural}}" },
  { slug: {{NAME_PLURAL}}_PERMISSIONS.create, label: "Create {{NamePlural}}" },
  { slug: {{NAME_PLURAL}}_PERMISSIONS.update, label: "Update {{NamePlural}}" },
  { slug: {{NAME_PLURAL}}_PERMISSIONS.delete, label: "Delete {{NamePlural}}" },
] as const;
