import { createHash, randomBytes } from "node:crypto";
import type {
  AuthenticatedAccount,
  AuthProvider,
} from "@sixthsummit/ship-api/app/auth/AuthProvider";
import type { AppEnv } from "@sixthsummit/ship-api/http/app/createApp";
import { createModuleApp } from "@sixthsummit/ship-api/http/app/createApp";
import { BadRequestError } from "@sixthsummit/ship-api/http/errors/BadRequestError";
import { NotFoundError } from "@sixthsummit/ship-api/http/errors/NotFoundError";
import { requireAuth } from "@sixthsummit/ship-api/http/middleware/requireAuth";
import { requirePermission } from "@sixthsummit/ship-api/http/middleware/requirePermission";
import { validate } from "@sixthsummit/ship-api/http/utils/validate";
import type { Hono, Schema } from "hono";
import type { BlankSchema } from "hono/types";
import { z } from "zod";

import type { OAuthAdapter, OAuthClientCredentials } from "./adapters/OAuthAdapter.js";
import type { OAuthAdapterRegistry } from "./adapters/OAuthAdapterRegistry.js";
import { OAUTH_PERMISSIONS } from "./permissions.js";
import { isActive, type OAuthConnection } from "./schema.js";
import type { OAuthConnectionService } from "./services/OAuthConnectionService.js";
import { InvalidStateError, type StateSecret, signState, verifyState } from "./state.js";
import { InMemoryStateJtiCache, type StateJtiCache } from "./stateJtiCache.js";

/**
 * v4 oauth routes — `defineOAuthRoutes(app, deps)`.
 *
 * Wires:
 *   - GET    /oauth                              list current user's connections
 *   - POST   /oauth/:providerCode/authorize      build authorize URL (returns { url, state })
 *   - GET    /oauth/:providerCode/callback       receive code+state, exchange, upsert
 *   - DELETE /oauth/:providerCode                disconnect (clear tokens; optionally revoke)
 *
 * The callback is GET because OAuth providers redirect via HTTP 302
 * after the user grants access — the browser does the request, not
 * application code.
 *
 * The authorize is POST and returns JSON `{ url, state }` rather than
 * doing a 302 redirect itself. This is API-first: SPAs and mobile
 * clients want the URL to load in a controlled way (new tab, in-app
 * browser, etc.) rather than have the API server pick the navigation
 * mode. The `Location`-redirect pattern is one `Response.redirect(url)`
 * away if the consumer prefers — they can layer their own GET route
 * that calls into the same flow.
 *
 * State management: framework-owned end-to-end. The authorize handler
 * signs a `StatePayload` (accountId + providerCode + optional returnTo
 * + optional extras) and embeds it in the URL the adapter builds.
 * The callback handler verifies the state against the same secret,
 * recovers the payload, and proceeds. Adapters never inspect state.
 */

export interface OAuthCredentialsResolver {
  /**
   * Look up the OAuth client credentials for a given provider. Returns
   * null when the provider isn't configured (caller env var unset).
   * Routes layer surfaces `null` as a 400 BadRequestError.
   */
  (providerCode: string): OAuthClientCredentials | null;
}

export interface OAuthRoutesDeps<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  service: OAuthConnectionService;
  provider: AuthProvider<TAccount>;
  adapters: OAuthAdapterRegistry;
  /**
   * Resolve `OAuthClientCredentials` per `providerCode`. Typically a
   * closure over the consumer's `defineEnv`-validated env config.
   */
  credentials: OAuthCredentialsResolver;
  /**
   * HMAC-SHA256 secret(s) for state signing. Source from the consumer's
   * env (e.g. `OAUTH_STATE_SECRET`). MUST be at least 32 bytes; this
   * function trusts the caller — `defineEnv` is the boundary.
   *
   * Pass an array to enable zero-downtime rotation: the head signs new
   * state, every entry is accepted on verify. See `StateSecret` for
   * the rotation pattern.
   */
  stateSecret: StateSecret;
  /**
   * Where the callback handler redirects on success when the
   * authorize call didn't supply a `returnTo`. Defaults to "/".
   */
  defaultRedirectUrl?: string;
  /**
   * Resolve the framework's account-id from `c.get('user')`. The
   * framework's `AuthProvider` returns whatever shape the consumer
   * configured for `Account`; the routes layer doesn't know the
   * shape. Defaults to reading `.id` (most common case).
   */
  resolveAccountId?: (user: TAccount) => string;
  /**
   * Origins permitted as absolute-URL `returnTo` targets at the
   * authorize endpoint. Each entry is an absolute URL whose `origin`
   * (scheme + host + port) is the comparison key.
   *
   * Same-origin relative paths (`/dashboard`, `/`) are always
   * accepted regardless of this list. Absolute URLs are rejected
   * entirely when the list is omitted or empty — the framework
   * defends against open-redirect chains originating on the
   * consumer's trusted login domain.
   *
   * Schemes outside `http:`/`https:` (e.g. `javascript:`, `data:`)
   * are rejected unconditionally. Protocol-relative `//host`,
   * backslash-host (`/\host`), and CRLF/null-byte payloads are
   * rejected unconditionally.
   */
  returnToAllowlist?: readonly string[];
  /**
   * Single-use cache for OAuth state nonces (F16). Every successful
   * callback records the verified state's nonce; a re-submit of the
   * same state within the cache's TTL (default 60 s, well above any
   * legitimate round-trip) is rejected as a replay.
   *
   * Defaults to an `InMemoryStateJtiCache` per `defineOAuthRoutes`
   * call. Multi-instance deployments (behind a load balancer) need
   * a shared backing to enforce single-use across nodes — pass a
   * Redis-backed `StateJtiCache` implementation.
   */
  stateJtiCache?: StateJtiCache;
}

const authorizeSchema = z
  .object({
    /** OAuth scopes to request. Provider-defined values. */
    scopes: z.array(z.string()).default([]),
    /** Where to redirect the user after the callback succeeds. */
    returnTo: z.string().optional(),
    /** Provider-specific options the adapter consults (`access_type`, etc.). */
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    /**
     * Free-form extras the framework round-trips through state — e.g.
     * a wizard step ID or a feature flag the callback page should see.
     * Not seen by the adapter; recovered intact on the callback.
     */
    extras: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const providerCodeParam = z.object({
  providerCode: z.string().min(1).max(50),
});

const callbackQuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

/**
 * ⚠️ FOOT-GUN: do NOT thread one shared `app` through several modules'
 * `defineXxxRoutes` calls — it accumulates one giant Hono route-type and
 * detonates `tsc` (TS2589) at scale. Prefer {@link buildOAuthApp} mounted via
 * `root.route("/", buildOAuthApp(deps))`. This raw form is kept for advanced
 * composition.
 */
// Generic over Hono's schema param `S` so an already-chained app keeps its
// previously registered route types — `Hono<AppEnv>` here would widen them
// away. See defineAccountsRoutes for the full rationale.
export function defineOAuthRoutes<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
  S extends Schema = BlankSchema,
>(app: Hono<AppEnv, S>, deps: OAuthRoutesDeps<TAccount>) {
  const auth = requireAuth({ provider: deps.provider });
  const resolveAccountId = deps.resolveAccountId ?? ((u: TAccount) => (u as { id: string }).id);
  const defaultRedirectUrl = deps.defaultRedirectUrl ?? "/";
  const returnToAllowlist = deps.returnToAllowlist ?? [];
  const stateJtiCache = deps.stateJtiCache ?? new InMemoryStateJtiCache();

  return app
    .get("/oauth", auth, requirePermission(OAUTH_PERMISSIONS.readSelf), async (c) => {
      const user = c.get("user" as never) as TAccount;
      const accountId = resolveAccountId(user);
      const rows = (await deps.service.getAll({
        where: { accountId },
      })) as OAuthConnection[];
      const summary = rows.map(summarizeConnection);
      return c.json(summary, 200);
    })
    .post(
      "/oauth/:providerCode/authorize",
      auth,
      requirePermission(OAUTH_PERMISSIONS.connect),
      validate("param", providerCodeParam),
      validate("json", authorizeSchema),
      async (c) => {
        const { providerCode } = c.req.valid("param");
        const body = c.req.valid("json");
        const adapter = requireAdapter(deps.adapters, providerCode);
        const credentials = requireCredentials(deps.credentials, providerCode);
        const user = c.get("user" as never) as TAccount;
        const accountId = resolveAccountId(user);
        const safeReturnTo = validateReturnTo(body.returnTo, returnToAllowlist);

        // PKCE (F12): generate a 256-bit verifier and the SHA-256
        // challenge. Verifier round-trips through the framework-
        // signed state; challenge goes to the provider via the
        // authorize URL. Defense-in-depth even for confidential
        // clients (OAuth 2.1 mandates PKCE).
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

        const state = signState(
          {
            accountId,
            providerCode,
            returnTo: safeReturnTo,
            extras: body.extras as Record<string, unknown> | undefined,
            codeVerifier,
          },
          deps.stateSecret,
        );

        const url = adapter.buildAuthorizationUrl(credentials, {
          state,
          scopes: body.scopes,
          providerOptions: body.providerOptions,
          codeChallenge,
          codeChallengeMethod: "S256",
        });

        return c.json({ url, state }, 200);
      },
    )
    .get(
      "/oauth/:providerCode/callback",
      validate("param", providerCodeParam),
      validate("query", callbackQuerySchema),
      async (c) => {
        const { providerCode } = c.req.valid("param");
        const q = c.req.valid("query");

        // Provider-error short-circuit: redirect with the error tag in
        // the URL so the consumer's UI surfaces something actionable.
        // F23: defensively truncate provider-supplied error strings to
        // 256 chars before round-tripping through the URL. Pathological
        // providers / malicious upstream proxies could otherwise emit
        // multi-KB error blobs that overflow Location-header limits or
        // bloat the consumer's UI.
        if (q.error) {
          return c.redirect(
            withQuery(defaultRedirectUrl, {
              oauth_error: q.error.slice(0, 256),
              oauth_error_description: (q.error_description ?? "").slice(0, 256),
            }),
            302,
          );
        }
        if (!q.code || !q.state) {
          throw new BadRequestError(
            "OAuth callback missing required `code` or `state` query param",
          );
        }

        let payload;
        try {
          payload = verifyState(q.state, deps.stateSecret);
        } catch (err) {
          if (err instanceof InvalidStateError) {
            throw new BadRequestError(err.message);
          }
          throw err;
        }
        if (payload.providerCode !== providerCode) {
          throw new BadRequestError(
            "OAuth callback `providerCode` does not match the state's bound provider",
          );
        }

        // F16: defend against state-replay within the signature
        // window. `verifyState` already enforces the 10-minute
        // expiry; this guards the (theoretical) window inside that
        // expiry where a leaked + replayed state could be exchanged
        // a second time if the upstream provider's auth-code
        // invalidation lagged.
        if (payload.nonce && stateJtiCache.seenAndRecord(payload.nonce)) {
          throw new BadRequestError("OAuth state already used");
        }

        const adapter = requireAdapter(deps.adapters, providerCode);
        const credentials = requireCredentials(deps.credentials, providerCode);

        const tokens = await adapter.exchangeCodeForTokens(q.code, credentials, {
          codeVerifier: payload.codeVerifier,
        });
        const providerAccountId = await adapter.getProviderAccountId(tokens, credentials);

        // Defense in depth: re-validate the state's `returnTo` against
        // the current allowlist before redirecting. A state signed under
        // an older (permissive) configuration must fail closed once the
        // operator tightens the allowlist. The validator throws
        // `BadRequestError` on any disallowed value.
        const safeTarget =
          validateReturnTo(payload.returnTo, returnToAllowlist) ?? defaultRedirectUrl;

        await deps.service.upsertTokens({
          accountId: payload.accountId,
          providerCode,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
          tokenType: tokens.tokenType,
          providerAccountId,
          metadata: tokens.metadata,
        });

        return c.redirect(safeTarget, 302);
      },
    )
    .delete(
      "/oauth/:providerCode",
      auth,
      requirePermission(OAUTH_PERMISSIONS.disconnect),
      validate("param", providerCodeParam),
      async (c) => {
        const { providerCode } = c.req.valid("param");
        const user = c.get("user" as never) as TAccount;
        const accountId = resolveAccountId(user);

        const existing = await deps.service.findByAccountAndProvider(accountId, providerCode);
        if (!existing) {
          throw new NotFoundError(`No OAuth connection for provider "${providerCode}"`);
        }

        // Best-effort upstream revoke — failure doesn't abort the
        // local clear (see adapter contract: revoke is "best-effort").
        if (
          existing.accessToken &&
          deps.adapters.has(providerCode) &&
          deps.adapters.get(providerCode)!.revokeAccess
        ) {
          const credentials = deps.credentials(providerCode);
          if (credentials) {
            try {
              await deps.adapters.require(providerCode).revokeAccess!(
                existing.accessToken,
                credentials,
              );
            } catch {
              // swallow — local clear still happens.
            }
          }
        }

        await deps.service.clearTokens(existing.id);
        return c.body(null, 204);
      },
    );
}

/**
 * Build the oauth module as its own sub-app, ready to mount on the root with
 * `root.route("/", buildOAuthApp(deps))`. Canonical wiring — see
 * {@link buildAccountsApp} for the rationale. Routes are tagged under the
 * `oauth` module in `/dev/routes` / `list_routes`.
 */
export function buildOAuthApp<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  deps: OAuthRoutesDeps<TAccount>,
) {
  return defineOAuthRoutes(createModuleApp("oauth"), deps);
}

function requireAdapter(registry: OAuthAdapterRegistry, providerCode: string): OAuthAdapter {
  const adapter = registry.get(providerCode);
  if (!adapter) {
    throw new BadRequestError(`No OAuth adapter registered for provider "${providerCode}"`);
  }
  return adapter;
}

function requireCredentials(
  resolver: OAuthCredentialsResolver,
  providerCode: string,
): OAuthClientCredentials {
  const credentials = resolver(providerCode);
  if (!credentials) {
    throw new BadRequestError(
      `OAuth credentials for provider "${providerCode}" are not configured`,
    );
  }
  return credentials;
}

/**
 * Strip secrets from a row before returning to the client. Tokens
 * never leave the server; status booleans + metadata are safe.
 */
function summarizeConnection(row: OAuthConnection) {
  return {
    id: row.id,
    providerCode: row.providerCode,
    providerAccountId: row.providerAccountId,
    scope: row.scope,
    expiresAt: row.expiresAt,
    isActive: isActive(row),
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Validate a user-supplied `returnTo` value before it is signed into
 * state or used as a `Location` redirect. Closes the open-redirect
 * chain that lets an anonymous attacker craft a phishing link pointing
 * at the consumer's trusted authorize endpoint with a 3rd-party return
 * URL. The framework-signed state defeats *tampering*, but the value
 * itself is user input — it must be validated up front.
 *
 * Accepted shapes:
 *   - `undefined` / empty → returns `undefined` (caller falls back to
 *     `defaultRedirectUrl`).
 *   - Same-origin relative path: must start with a single `/` (not
 *     `//`, not `/\\`) and not contain CR / LF / null bytes (Location-
 *     header injection vectors). The full string is returned as-is.
 *   - Absolute URL whose `origin` matches an entry in `allowlist`. The
 *     allowlist entries are normalized by `new URL(entry).origin`.
 *
 * Everything else throws `BadRequestError`:
 *   - Non-http(s) schemes (`javascript:`, `data:`, `vbscript:`,
 *     `file:`, `ms-…:`, etc.).
 *   - Protocol-relative `//host` and backslash-host `/\\host`.
 *   - Absolute URLs whose origin is not in the allowlist (including
 *     all absolute URLs when the allowlist is empty).
 *   - Malformed URL strings.
 *
 * Exported (alongside the route factory) so consumers building their
 * own redirect-bearing endpoints can apply the same defense.
 */
export function validateReturnTo(
  returnTo: string | undefined,
  allowlist: readonly string[],
): string | undefined {
  if (returnTo == null || returnTo === "") return undefined;

  // Reject header-injection shapes outright. Hono's `c.redirect()`
  // sets the `Location` header — CR / LF / NUL would let an attacker
  // forge response headers.
  if (/[\r\n\0]/.test(returnTo)) {
    throw new BadRequestError("Invalid returnTo: contains illegal characters");
  }

  // Same-origin relative paths. Reject "//host" (protocol-relative)
  // and "/\\host" (some user-agents resolve the backslash as a host
  // separator, escaping the origin).
  if (returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.startsWith("/\\")) {
    return returnTo;
  }

  // Anything not starting with "/" must be an absolute URL parseable
  // by `URL`, whose origin matches an allowlist entry.
  let parsed: URL;
  try {
    parsed = new URL(returnTo);
  } catch {
    throw new BadRequestError("Invalid returnTo: not a valid URL");
  }

  // Disallow non-http(s) schemes even if listed somehow.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError(`Invalid returnTo: scheme "${parsed.protocol}" not permitted`);
  }

  if (allowlist.length === 0) {
    throw new BadRequestError("Invalid returnTo: absolute URLs require returnToAllowlist");
  }

  for (const entry of allowlist) {
    let entryOrigin: string;
    try {
      entryOrigin = new URL(entry).origin;
    } catch {
      // Malformed allowlist entry — skip it. (Operator misconfig; the
      // request is still rejected if no other entry matches.)
      continue;
    }
    if (parsed.origin === entryOrigin) {
      return returnTo;
    }
  }

  throw new BadRequestError("Invalid returnTo: origin not in returnToAllowlist");
}

function withQuery(url: string, params: Record<string, string>): string {
  // Preserves an existing query string by appending. Simple
  // string-level concat — intentionally avoids the `URL` constructor
  // since callers may pass relative paths (e.g. "/onboarding").
  const sep = url.includes("?") ? "&" : "?";
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString();
  return qs ? `${url}${sep}${qs}` : url;
}
