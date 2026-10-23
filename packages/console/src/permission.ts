import { type PermissionAccess, permission } from "@sixthsummit/ship-core";

/**
 * The one permission every console operation requires. It is deliberately
 * not derived from `ship.jobs:manage`, `ship.outbox:manage`,
 * `ship.webhooks:replay` or any application admin role: an actor must be
 * granted it explicitly, so a console mount never widens what an existing
 * role can do.
 */
export const CONSOLE_OPERATE_PERMISSION = "console.operate";

/** `permission(CONSOLE_OPERATE_PERMISSION)`, the access every console operation declares. */
export function consoleAccess(): PermissionAccess {
  return permission(CONSOLE_OPERATE_PERMISSION);
}
