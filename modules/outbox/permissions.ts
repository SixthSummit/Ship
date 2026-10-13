/**
 * Permission slugs for the outbox module.
 *
 * v3 had no permissions for the JobController routes (operational
 * tooling assumed admin-only). v4 makes the permission boundary
 * explicit so the same module can ship to consumers who route admin
 * traffic through different RBAC layers.
 */

import type { PermissionDefinition } from "@sixthsummit/ship-api";

export const OUTBOX_PERMISSIONS = {
  /** View outbox events (for one's own scope or all, depending on RBAC). */
  outboxRead: "outbox:read",
  /** Trigger drain manually (admin operation). */
  outboxDrain: "outbox:drain",
  /** Recover stale processing events (admin operation). */
  outboxRecover: "outbox:recover",
} as const;

export type OutboxPermission = (typeof OUTBOX_PERMISSIONS)[keyof typeof OUTBOX_PERMISSIONS];

export const OUTBOX_PERMISSION_DEFINITIONS = [
  {
    slug: OUTBOX_PERMISSIONS.outboxRead,
    label: "View Outbox Events",
  },
  {
    slug: OUTBOX_PERMISSIONS.outboxDrain,
    label: "Drain Outbox (Admin)",
  },
  {
    slug: OUTBOX_PERMISSIONS.outboxRecover,
    label: "Recover Stale Outbox Events (Admin)",
  },
] as const satisfies readonly PermissionDefinition[];
