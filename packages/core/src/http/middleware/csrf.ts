import { randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { AuthorizationError } from "../errors/AuthorizationError.js";
import { checkCookieDomainAgainstPublicSuffix } from "../utils/publicSuffix.js";

/**
 * `csrf({ allowedOrigins, doubleSubmit? })` — declared CSRF stance.
 *
 * Default mode (`doubleSubmit: false`):
 *   - Mutating requests (POST/PUT/PATCH/DELETE) must carry an `Origin` (or
 *     `Referer`) header whose origin matches one of `allowedOrigins`.
 *   - `Sec-Fetch-Site: cross-site` is rejected outright when the header is
 *     present (modern browsers; gracefully ignored on older clients).
 *   - This protects against the typical "user follows a link / submits a
 *     form on attacker.com that hits api.yours.com" scenario when paired
 *     with `httpOnly, secure, sameSite=lax` session/JWT cookies.
 *
 * Hardened mode (`doubleSubmit: true`):
 *   - Issues a `csrfToken` cookie on safe (GET/HEAD/OPTIONS) requests when
 *     none is present.
 *   - On mutating requests, requires the client to echo the cookie value
 *     in the `X-CSRF-Token` header (the "double-submit cookie" pattern).
 *   - Cookie comparison uses `crypto.timingSafeEqual`.
 *   - Recommended for: third-party-iframed apps, multi-subdomain consumers
 *     where SameSite=lax doesn't fully protect.
 *
 * Documented in `.cursor/rules/security.mdc` (Why subprotocol over alternatives,
 * and the CSRF stance).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE_NAME = "ship_csrf";
const HEADER_NAME = "x-csrf-token";

export interface CsrfOptions {
  /**
   * Origins permitted to make mutating requests. Compared exactly (scheme +
   * host + port). Required.
   */
  allowedOrigins: readonly string[];
  /**
   * Enable the double-submit cookie pattern. Default `false` (Origin check
   * only).
   *
   * **F27 — threat model note.** The double-submit cookie is intentionally
   * readable by JavaScript (`httpOnly: false`) so the SPA can echo it
   * into the request header. This means **an XSS bug becomes a CSRF
   * defense bypass**: attacker-controlled script reads the cookie,
   * sets the matching header, and submits a mutating request. The
   * double-submit pattern is therefore **defense-in-depth on top of
   * CSP-defended XSS**, not a standalone bulwark.
   *
   * Operators should pair this middleware with:
   *   - A strict Content-Security-Policy (`default-src 'self'`,
   *     `script-src 'self' 'strict-dynamic'`, nonced inline scripts).
   *   - Subresource integrity for third-party scripts.
   *   - Trusted Types where the runtime supports it.
   *
   * If your XSS posture is uncertain, prefer header-only mode (see
   * `headerOnly` below) — clients track the token in memory + reply
   * via the header, never as a cookie.
   */
  doubleSubmit?: boolean;
  /**
   * **F27 — header-only mode.** When `true` (and `doubleSubmit: true`),
   * the framework does NOT set a cookie on safe requests. The client
   * is responsible for fetching a token via an out-of-band channel
   * (a `GET /api/csrf-token` route the consumer defines, or the same-
   * response-as-the-page approach) and storing it in memory only.
   * Header-only mode trades client-side complexity for an
   * XSS-doesn't-bypass-CSRF property.
   *
   * Default `false` (cookie-based double-submit — backwards-compatible).
   */
  headerOnly?: boolean;
  /**
   * Override the cookie name. Default `"ship_csrf"`.
   */
  cookieName?: string;
  /**
   * Override the header name clients echo the cookie into. Default
   * `"x-csrf-token"`.
   */
  headerName?: string;
  /**
   * Cookie attribute overrides for the double-submit token.
   */
  cookie?: {
    domain?: string;
    sameSite?: "Strict" | "Lax" | "None";
    secure?: boolean;
    maxAge?: number;
  };
}

/**
 * Extract a canonical origin from `Origin` (preferred) or `Referer`
 * (fallback). F24: both paths are validated via `new URL(...)` so a
 * malformed value (`javascript:alert()`, garbage, empty-after-trim)
 * never makes it to the allowlist membership check. Returned origin
 * is lowercased so the allowlist comparison is case-insensitive (per
 * RFC 6454 §4 hosts MUST compare ASCII-case-insensitively).
 */
function originFromHeaders(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return `${url.protocol}//${url.host}`.toLowerCase();
    } catch {
      return undefined;
    }
  }
  const referer = c.req.header("referer");
  if (!referer) return undefined;
  try {
    const url = new URL(referer);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Token length in characters. `randomBytes(24).toString('base64url')`
 * always produces exactly 32 base64url characters. F25: the
 * double-submit verifier checks both cookie + header against this
 * length before the constant-time compare, so an attacker who can
 * only forge a wrong-length value (e.g. truncated by a buggy proxy,
 * or a deliberate short-circuit attempt) gets a fast rejection
 * without revealing per-byte timing of the compare.
 */
const TOKEN_LENGTH = 32;

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf); // dummy to keep timing constant-ish
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function csrf(opts: CsrfOptions): MiddlewareHandler {
  if (!opts.allowedOrigins || opts.allowedOrigins.length === 0) {
    throw new Error("csrf(): `allowedOrigins` must be a non-empty list");
  }

  // F5: defend the consumer's double-submit cookie against public-
  // suffix domain misconfiguration at middleware-construction time.
  const domainFailure = checkCookieDomainAgainstPublicSuffix(opts.cookie?.domain);
  if (domainFailure) {
    throw new Error(`csrf(): invalid cookie.domain — ${domainFailure}`);
  }

  // F24: lowercase the allowlist so origin comparison is
  // case-insensitive per RFC 6454 §4 (hosts compare ASCII-case-
  // insensitively). Without this, `https://App.Example.com` in the
  // config wouldn't match `https://app.example.com` from a browser.
  const allowed = new Set(opts.allowedOrigins.map((o) => o.toLowerCase()));
  const doubleSubmit = opts.doubleSubmit ?? false;
  const headerOnly = opts.headerOnly ?? false;
  const cookieName = opts.cookieName ?? COOKIE_NAME;
  const headerName = (opts.headerName ?? HEADER_NAME).toLowerCase();
  const cookieAttrs = opts.cookie ?? {};

  const middleware: MiddlewareHandler = async (c, next) => {
    const method = c.req.method.toUpperCase();
    const isSafe = SAFE_METHODS.has(method);

    // F27 — header-only mode skips cookie issuance. Consumer fetches
    // tokens out-of-band and stores in memory only. For double-submit
    // mode without `headerOnly`, ensure a token cookie exists; we
    // issue on safe requests so the SPA picks it up before the first
    // mutation.
    if (doubleSubmit && !headerOnly && isSafe && !getCookie(c, cookieName)) {
      const token = generateToken();
      setCookie(c, cookieName, token, {
        httpOnly: false, // client JS must read it to echo into the header
        secure: cookieAttrs.secure ?? true,
        sameSite: cookieAttrs.sameSite ?? "Lax",
        domain: cookieAttrs.domain,
        maxAge: cookieAttrs.maxAge ?? 60 * 60 * 24 * 7,
        path: "/",
      });
    }

    if (isSafe) return next();

    // Mutating request — apply Origin check.
    const origin = originFromHeaders(c);
    if (!origin || !allowed.has(origin)) {
      throw new AuthorizationError(
        origin
          ? `CSRF: origin "${origin}" is not allowed`
          : "CSRF: missing Origin / Referer header on mutating request",
      );
    }

    // Modern browsers tag cross-site initiations explicitly.
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite === "cross-site") {
      throw new AuthorizationError("CSRF: Sec-Fetch-Site is cross-site");
    }

    // Hardened: double-submit cookie ↔ header.
    if (doubleSubmit) {
      const cookie = getCookie(c, cookieName);
      const header = c.req.header(headerName);
      if (!cookie) {
        throw new AuthorizationError(`CSRF: missing ${cookieName} cookie`);
      }
      if (!header) {
        throw new AuthorizationError(`CSRF: missing ${headerName} header`);
      }
      // F25: reject wrong-length values before the constant-time
      // compare. An empty cookie + empty header would otherwise
      // short-circuit safeEqual (both buffers length 0, equal), and
      // a truncated cookie matched against a truncated header would
      // pass against an attacker who controls both sides. Tokens are
      // exactly TOKEN_LENGTH chars by construction; any deviation is
      // either tampering or a buggy proxy.
      if (cookie.length !== TOKEN_LENGTH || header.length !== TOKEN_LENGTH) {
        throw new AuthorizationError("CSRF: cookie / header has wrong length");
      }
      if (!safeEqual(cookie, header)) {
        throw new AuthorizationError("CSRF: cookie / header mismatch");
      }
    }

    return next();
  };

  return middleware;
}
