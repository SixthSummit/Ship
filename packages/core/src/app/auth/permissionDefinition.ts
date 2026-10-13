/**
 * Canonical shape of a permission definition.
 *
 * Each module exports a `<MODULE>_PERMISSION_DEFINITIONS: readonly
 * PermissionDefinition[]` array that the consuming app's bootstrapper / seed
 * upserts into the Permission table. `slug` is the forward-compatible
 * identifier (`module[:resource]:action` — lowercase, colon-separated;
 * hyphenate multi-word actions, e.g. `oauth:connections:read-self`); `label`
 * is the human-facing string shown in admin UIs.
 *
 * Contract: once an app deploys against a slug it is frozen — changing or
 * removing a slug is a breaking change. `label` may change freely.
 */
export interface PermissionDefinition {
  /** Stable `module[:resource]:action` identifier checked by `requirePermission`. */
  slug: string;
  /** Human-facing name surfaced in admin UIs when assigning permissions to roles. */
  label: string;
}
