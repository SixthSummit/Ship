import type { MiddlewareHandler } from "hono";
import type { AuthenticatedAccount } from "../../app/auth/AuthProvider.js";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { AuthorizationError } from "../errors/AuthorizationError.js";
import { PERMISSION_META, type PermissionMeta, setMetaTag } from "../utils/metaTags.js";

/**
 * `requirePermission(...slugs)` — Hono middleware factory that enforces
 * the authenticated user has at least one of the supplied permission slugs
 * (OR semantics within a single call).
 *
 * Replaces v3's `@HasPermission` decorator. To express AND across multiple
 * permission groups, chain multiple `requirePermission()` middlewares —
 * `createApp`'s registry interceptor unions slugs across calls so the
 * registry shows the full set, and the runtime checks each call gates
 * independently.
 *
 * Must run *after* a `requireAuth(...)` middleware on the same route — if
 * `c.get('user')` is unset, this throws `AuthenticationError`. The user
 * object must implement `hasPermission(slug)`; if not, this throws an
 * Error (configuration issue → 500).
 *
 * Tagged with `PERMISSION_META` so `createApp`'s interceptor and downstream
 * tooling (MCP `describe_route`, `ship-reviewer`, `/dev/routes`) see the
 * permission slugs the route requires.
 */
export function requirePermission(...slugs: string[]): MiddlewareHandler {
  if (slugs.length === 0) {
    throw new Error("requirePermission(): at least one slug must be provided");
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const user = c.get("user" as never) as AuthenticatedAccount | undefined;

    if (!user) {
      throw new AuthenticationError(
        "requirePermission: no authenticated user — apply requireAuth(...) before this middleware",
      );
    }

    if (typeof user.hasPermission !== "function") {
      throw new Error(
        "requirePermission: the resolved user does not implement hasPermission(slug). " +
          "Ensure your AuthProvider's resolve() returns an Account that does.",
      );
    }

    for (const slug of slugs) {
      const ok = await user.hasPermission(slug);
      if (ok) return next();
    }

    throw new AuthorizationError(
      slugs.length === 1
        ? `Missing required permission: ${slugs[0]}`
        : `Requires one of: ${slugs.join(", ")}`,
    );
  };

  const tag: PermissionMeta = { permissions: [...slugs] };
  setMetaTag(middleware, PERMISSION_META, tag);

  return middleware;
}
