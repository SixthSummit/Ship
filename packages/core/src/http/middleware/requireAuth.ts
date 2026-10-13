import type { MiddlewareHandler } from "hono";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
} from "../../app/auth/AuthProvider.js";
import { setRequestContextField } from "../../app/context/RequestContext.js";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { AuthorizationError } from "../errors/AuthorizationError.js";
import { AUTH_META, type AuthMeta, setMetaTag } from "../utils/metaTags.js";

/**
 * `requireAuth({ provider, ... })` — Hono middleware factory that runs the
 * configured `AuthProvider` chain (verify + resolve) and attaches the
 * authenticated `Account` to `c.set('user', ...)`.
 *
 * Replaces v3's `JwtAuthMiddleware`. Key differences:
 *
 * 1. **Pluggable**. Backed by the `AuthProvider` interface; Firebase is
 *    adapter #1, but any v4.x adapter (Better-Auth / Clerk / WorkOS / …)
 *    drops in without changing this middleware.
 *
 * 2. **Silent fall-through is opt-in**. The v3 default (no token →
 *    `next()` without user) was a footgun. v4 throws `AuthenticationError`
 *    when a token is missing unless `optional: true` is set explicitly.
 *
 * 3. **Tagged for the route registry**. `createApp`'s interceptor reads
 *    the `AUTH_META` tag to populate the route registry with auth state
 *    so MCP tools, `ship-reviewer`, and `/dev/routes` know whether each
 *    route requires auth.
 *
 * 4. **Throws AppErrors**, not direct responses. `app.onError(...)` formats
 *    them — keeps the response shape consistent across the framework.
 *
 * Failure mapping:
 * - `missing-token` + `optional: false` → 401 `AuthenticationError`
 * - `missing-token` + `optional: true`  → `next()` with no user / claims
 * - any other verify failure (invalid / expired / revoked / issuer-mismatch)
 *   → 401 `AuthenticationError` regardless of `optional` (a present-but-bad
 *   token is always rejected)
 * - verify ok + resolve returns null + `onUnknownAccount: 'reject'` (default)
 *   → 403 `AuthorizationError`
 * - verify ok + resolve null + `onUnknownAccount: 'next'` → `next()` with
 *   `claims` set but no `user`
 *
 * On success: sets `c.set('user', account)` and `c.set('claims', claims)`,
 * publishes `account.id` to `RequestContext.userId` (so audit-stamping and
 * structured logging see the actor), then `next()`.
 */

export interface RequireAuthOptions<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  /** The AuthProvider to use. Required. */
  provider: AuthProvider<TAccount>;
  /**
   * If true, missing tokens fall through to `next()` without throwing. Default
   * `false`. Use this for endpoints that serve unauthenticated traffic with
   * degraded data (e.g., a public profile page that shows extra fields when
   * logged in).
   */
  optional?: boolean;
}

/** Hono context-variable keys this middleware sets on success. */
export const AUTH_CONTEXT_KEYS = {
  user: "user" as const,
  claims: "claims" as const,
};

function buildProviderContext(c: Parameters<MiddlewareHandler>[0]): AuthProviderContext {
  const headers: Record<string, string | undefined> = {};
  // Hono normalizes header names to lowercase; AuthProvider adapters
  // (firebase) expect lowercase too.
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { headers };
}

export function requireAuth<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  opts: RequireAuthOptions<TAccount>,
): MiddlewareHandler {
  const { provider } = opts;
  const optional = opts.optional ?? false;

  const middleware: MiddlewareHandler = async (c, next) => {
    const providerCtx = buildProviderContext(c);
    const verifyResult = await provider.verify(providerCtx);

    if (!verifyResult.ok) {
      if (verifyResult.reason === "missing-token") {
        if (optional) return next();
        throw new AuthenticationError(verifyResult.message ?? "Authentication required");
      }
      // present-but-bad token is always rejected, even when optional=true
      throw new AuthenticationError(
        verifyResult.message ?? `Authentication failed (${verifyResult.reason})`,
      );
    }

    const claims: AuthClaims = verifyResult.claims;
    const account = await provider.resolve(claims);

    if (account === null) {
      const policy = provider.onUnknownAccount ?? "reject";
      if (policy === "next") {
        c.set(AUTH_CONTEXT_KEYS.claims as never, claims as never);
        return next();
      }
      // 'create' is the provider's responsibility — if a provider wants
      // first-sight account creation it does it inside `resolve()` itself.
      // Here we treat 'create' as 'reject' (no-op) since we can't synthesize
      // an account.
      throw new AuthorizationError("No account registered for this credential");
    }

    c.set(AUTH_CONTEXT_KEYS.user as never, account as never);
    c.set(AUTH_CONTEXT_KEYS.claims as never, claims as never);
    // Publish the resolved account id to the request context so the logger,
    // `DrizzleEntityService` audit-stamping (createdBy / updatedBy), and OTel
    // spans all see the actor. No-op (returns false) outside an active context.
    setRequestContextField("userId", account.id);
    return next();
  };

  const tag: AuthMeta = {
    required: !optional,
    providerName: provider.name,
  };
  setMetaTag(middleware, AUTH_META, tag);

  return middleware;
}
