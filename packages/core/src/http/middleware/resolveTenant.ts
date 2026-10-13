import type { Context, MiddlewareHandler } from "hono";
import { setRequestContextField } from "../../app/context/RequestContext.js";
import { AUTH_CONTEXT_KEYS } from "./requireAuth.js";

/**
 * `resolveTenant()` — opt-in middleware that resolves the active tenant for the
 * request and publishes it to `RequestContext.tenantId`.
 *
 * The framework convention is: code reads the active tenant from
 * `RequestContext.tenantId`, NEVER from `account.tenantId` directly. That
 * indirection is what keeps a future one-tenant-per-user → membership move
 * (Model A → B) a one-middleware change — swap this resolver and every
 * downstream read is unaffected.
 *
 * Default (Model A — one tenant per account): read `tenantId` off the
 * authenticated account that `requireAuth` placed on the Hono context. Wire it
 * AFTER `requireAuth`:
 *
 * ```ts
 * app.use("*", requireAuth({ provider }));
 * app.use("*", resolveTenant());
 * ```
 *
 * For custom resolution (a tenant header, a sub-domain, a membership lookup),
 * pass `resolve`:
 *
 * ```ts
 * app.use("*", resolveTenant({ resolve: (c) => c.req.header("x-tenant-id") }));
 * ```
 *
 * This is a thin, opt-in helper — single-tenant products never wire it and
 * `RequestContext.tenantId` stays `undefined`. Tenant *enforcement*
 * (auto-scoping every query) is deferred to V8; this only resolves + publishes.
 */
export interface ResolveTenantOptions {
  /**
   * Custom resolver. Receives the Hono context and returns the active tenant id
   * (or `undefined` / `null` to leave `RequestContext.tenantId` unset). Default:
   * read `tenantId` off the authenticated account (`c.get("user")`).
   */
  resolve?: (c: Context) => string | null | undefined | Promise<string | null | undefined>;
}

export function resolveTenant(opts: ResolveTenantOptions = {}): MiddlewareHandler {
  const resolve =
    opts.resolve ??
    ((c: Context) => {
      const account = c.get(AUTH_CONTEXT_KEYS.user as never) as { tenantId?: string } | undefined;
      return account?.tenantId;
    });

  return async (c, next) => {
    const tenantId = await resolve(c);
    // No-op (returns false) when called outside an active RequestContext.
    if (tenantId) setRequestContextField("tenantId", tenantId);
    return next();
  };
}
