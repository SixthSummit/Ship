import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { AuthTokenPair } from "../../app/auth/jwt/AuthFlow.js";
import { checkCookieDomainAgainstPublicSuffix } from "./publicSuffix.js";

/**
 * `authCookies` — set / clear / read the access + refresh cookie pair.
 *
 * The framework's locked default for stateless cookie auth:
 *
 *   • Two cookies — `ship_access` (the JWT) and `ship_refresh` (the opaque
 *     refresh token).
 *   • Both `httpOnly: true`, `secure: true` in production, `sameSite: 'lax'`
 *     by default — protects top-level navigation CSRF.
 *   • Refresh cookie scoped to `path: '/auth/refresh'` so it only ships to
 *     the rotation endpoint. Limits the blast radius if `httpOnly` is ever
 *     bypassed by a runtime bug or a consumer mis-configuring CORS.
 *   • `maxAge` mirrors the token's `expiresAt` so browsers drop the cookie
 *     at the same moment the server stops accepting it.
 *
 * Hardened CSRF mode (double-submit) is in `csrf.ts`. This file is purely
 * about cookie I/O — does not enforce policy.
 */

/** Default cookie names. Overridable per-call. */
export const AUTH_COOKIE_NAMES = {
  access: "ship_access",
  refresh: "ship_refresh",
} as const;

/** Default refresh-cookie path scope. */
export const REFRESH_COOKIE_PATH = "/auth/refresh";

export interface AuthCookieConfig {
  /** Override the access-cookie name. Default `"ship_access"`. */
  accessCookieName?: string;
  /** Override the refresh-cookie name. Default `"ship_refresh"`. */
  refreshCookieName?: string;
  /** Override the refresh-cookie path scope. Default `"/auth/refresh"`. */
  refreshCookiePath?: string;
  /**
   * `secure` flag. Default: `true` in production, `false` otherwise — but
   * **always set `true`** in any environment that issues real tokens. The
   * "false in dev" default exists for `localhost` HTTP only.
   */
  secure?: boolean;
  /** `sameSite` attribute. Default `"Lax"`. */
  sameSite?: "Strict" | "Lax" | "None";
  /**
   * Optional cookie `Domain` attribute. Defaults to host-only
   * (attribute omitted) — the secure default for single-host
   * deployments. Set to `".your-org.tld"` only when you genuinely
   * need cookies to span multiple subdomains.
   *
   * **Validated against a public-suffix list.** Values that are
   * themselves a public suffix (`".com"`, `".co.uk"`, `".com.au"`,
   * etc.) throw at config time — those would leak the cookie to
   * every site under the suffix and breach tenant isolation. Pass a
   * registrable domain (`".example.com"`, `".my-org.co.uk"`)
   * instead.
   */
  domain?: string;
}

const DEFAULT_CONFIG: Required<Omit<AuthCookieConfig, "domain">> = {
  accessCookieName: AUTH_COOKIE_NAMES.access,
  refreshCookieName: AUTH_COOKIE_NAMES.refresh,
  refreshCookiePath: REFRESH_COOKIE_PATH,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax",
};

function resolveConfig(
  cfg: AuthCookieConfig | undefined,
): Required<Omit<AuthCookieConfig, "domain">> & { domain?: string } {
  const domainFailure = checkCookieDomainAgainstPublicSuffix(cfg?.domain);
  if (domainFailure) {
    throw new Error(`authCookies: invalid AuthCookieConfig.domain — ${domainFailure}`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    secure: cfg?.secure ?? DEFAULT_CONFIG.secure,
    sameSite: cfg?.sameSite ?? DEFAULT_CONFIG.sameSite,
  };
}

/**
 * Set both cookies on the response after a successful issue/rotate. The
 * `expiresAt` values from the `AuthTokenPair` are converted into `maxAge`
 * (seconds) so the browser drops them in lock-step with the server.
 */
export function setAuthCookies(c: Context, pair: AuthTokenPair, cfg?: AuthCookieConfig): void {
  const config = resolveConfig(cfg);
  const nowSec = Math.floor(Date.now() / 1000);

  const accessOpts: CookieOptions = {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: "/",
    maxAge: Math.max(0, pair.accessTokenExpiresAt - nowSec),
    ...(config.domain ? { domain: config.domain } : {}),
  };

  const refreshOpts: CookieOptions = {
    httpOnly: true,
    secure: config.secure,
    sameSite: config.sameSite,
    path: config.refreshCookiePath,
    maxAge: Math.max(0, pair.refreshTokenExpiresAt - nowSec),
    ...(config.domain ? { domain: config.domain } : {}),
  };

  setCookie(c, config.accessCookieName, pair.accessToken, accessOpts);
  setCookie(c, config.refreshCookieName, pair.refreshToken, refreshOpts);
}

/**
 * Clear both cookies on logout. Sets identical attributes to `setAuthCookies`
 * so browsers reliably overwrite the existing cookies (browsers match on
 * name+path+domain, not value).
 */
export function clearAuthCookies(c: Context, cfg?: AuthCookieConfig): void {
  const config = resolveConfig(cfg);
  const baseOpts: CookieOptions = {
    secure: config.secure,
    sameSite: config.sameSite,
    ...(config.domain ? { domain: config.domain } : {}),
  };
  deleteCookie(c, config.accessCookieName, { ...baseOpts, path: "/" });
  deleteCookie(c, config.refreshCookieName, {
    ...baseOpts,
    path: config.refreshCookiePath,
  });
}

/** Read the access cookie value. Returns `undefined` if absent. */
export function readAccessCookie(c: Context, cfg?: AuthCookieConfig): string | undefined {
  const config = resolveConfig(cfg);
  return getCookie(c, config.accessCookieName);
}

/** Read the refresh cookie value. Returns `undefined` if absent. */
export function readRefreshCookie(c: Context, cfg?: AuthCookieConfig): string | undefined {
  const config = resolveConfig(cfg);
  return getCookie(c, config.refreshCookieName);
}
