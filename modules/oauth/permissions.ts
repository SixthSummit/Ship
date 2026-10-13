/**
 * Permission slugs for the oauth module.
 *
 * v3 enforced authorization via @HasPermission decorators on controller
 * methods; v4 enforces it via `requirePermission(slug)` middleware at
 * the route. The permission rows themselves are seeded by the consuming
 * app.
 */

import type { PermissionDefinition } from "@sixthsummit/ship-api";

export const OAUTH_PERMISSIONS = {
  /** View one's own connections (typical scope for end-user-facing endpoints). */
  readSelf: "oauth:connections:read-self",
  /** View any connection (admin-style; for support/audit UIs). */
  readAny: "oauth:connections:read-any",
  /** Initiate a new OAuth connection on one's own account. */
  connect: "oauth:connections:connect",
  /** Revoke / disconnect a connection. */
  disconnect: "oauth:connections:disconnect",
  /** Force-refresh an access token. */
  refresh: "oauth:connections:refresh",
} as const;

export type OAuthPermission = (typeof OAUTH_PERMISSIONS)[keyof typeof OAUTH_PERMISSIONS];

export const OAUTH_PERMISSION_DEFINITIONS = [
  {
    slug: OAUTH_PERMISSIONS.readSelf,
    label: "View Own OAuth Connections",
  },
  {
    slug: OAUTH_PERMISSIONS.readAny,
    label: "View Any OAuth Connection (Admin)",
  },
  { slug: OAUTH_PERMISSIONS.connect, label: "Initiate OAuth Connection" },
  { slug: OAUTH_PERMISSIONS.disconnect, label: "Disconnect OAuth Provider" },
  { slug: OAUTH_PERMISSIONS.refresh, label: "Force-Refresh OAuth Token" },
] as const satisfies readonly PermissionDefinition[];
