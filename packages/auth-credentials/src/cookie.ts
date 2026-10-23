import { randomBytes } from "node:crypto";
import type { HonoPreValidationPolicy } from "@sixthsummit/ship-hono";
import { constantTimeEqualStrings } from "./crypto/tokens.js";
import { InvalidCredentialAuthDefinitionError } from "./errors.js";

/** How a session token travels: the `Authorization: Bearer` header or an `httpOnly` cookie. */
export type CredentialSessionTransport = "bearer" | "cookie";

export const DEFAULT_SESSION_COOKIE_NAME = "ship_session";
export const DEFAULT_CSRF_COOKIE_NAME = "ship_csrf";
/** Matches the compatibility distribution's `csrf()` middleware and the Angular cookie capability default. */
export const DEFAULT_CSRF_HEADER = "x-csrf-token";

/** HTTP methods that never change state and are therefore exempt from the CSRF check. */
export const SAFE_HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
// Printable ASCII without `;` (RFC 6265 path-value), spelled as ranges so no control character appears in the source.
const COOKIE_PATH_PATTERN = /^\/[!-:<-~]*$/u;
const COOKIE_DOMAIN_PATTERN =
  /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/u;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export interface CredentialSessionCsrfOptions {
  /** The readable cookie the client echoes. Defaults to `ship_csrf`. */
  readonly cookieName?: string;
  /** The request header the client echoes it in. Defaults to `x-csrf-token`. */
  readonly header?: string;
}

export interface CredentialSessionCookieOptions {
  /**
   * Cookie name. Defaults to `ship_session`. A `__Host-` prefix is honoured
   * and enforces `Secure`, `Path=/` and no `Domain`, which is the strongest
   * shape a browser offers.
   */
  readonly name?: string;
  /** Defaults to `/`. */
  readonly path?: string;
  /**
   * Set only when the app and the API live on different hosts of one site
   * (`app.example.com` and `api.example.com` share `example.com`): both
   * cookies are then scoped to that domain so the session is sent to the
   * API and the CSRF cookie is readable by the app. Omit on one origin.
   */
  readonly domain?: string;
  /** Defaults to `lax`; `strict` also drops the cookie from top-level navigations into the app. */
  readonly sameSite?: "lax" | "strict";
  /**
   * Defaults to `true` and is mandatory unless `environment` is
   * `"development"`: a session cookie must never travel over plain HTTP.
   */
  readonly secure?: boolean;
  readonly csrf?: CredentialSessionCsrfOptions;
}

export interface CredentialSessionOptions {
  /**
   * `bearer` (the default) answers sign-in with the token in the body;
   * `cookie` sets the `httpOnly` cookie and never returns the token; `both`
   * lets each sign-in choose through its `transport` field, bearer by default.
   */
  readonly transport?: "bearer" | "cookie" | "both";
  readonly cookie?: CredentialSessionCookieOptions;
  /**
   * What the `Secure` rule means by development: only an explicit
   * `"development"` here permits `secure: false`. The package never reads
   * `NODE_ENV`; the application decides at its configuration boundary.
   */
  readonly environment?: "development" | "production";
}

/** The resolved cookie attributes, frozen at definition time. */
export interface CredentialSessionCookiePolicy {
  readonly name: string;
  readonly path: string;
  readonly domain?: string;
  readonly sameSite: "lax" | "strict";
  readonly secure: boolean;
  readonly csrf: { readonly cookieName: string; readonly header: string };
}

/** The resolved session transport policy the module and the adapter share. */
export interface CredentialSessionPolicy {
  readonly transports: readonly CredentialSessionTransport[];
  /** What a sign-in uses when its body names no transport. */
  readonly defaultTransport: CredentialSessionTransport;
  /** Present exactly when `cookie` is among the transports. */
  readonly cookie?: CredentialSessionCookiePolicy;
  readonly environment: "development" | "production";
}

export const DEFAULT_SESSION_POLICY: CredentialSessionPolicy = Object.freeze({
  transports: Object.freeze(["bearer"] as const),
  defaultTransport: "bearer",
  environment: "production",
});

function invalid(message: string, field: string): InvalidCredentialAuthDefinitionError {
  return new InvalidCredentialAuthDefinitionError("SHIP_AUTH_OPTIONS_INVALID", message, {
    field,
  });
}

/** Validates and freezes the session transport options; refuses an insecure cookie outside development. */
export function resolveSessionPolicy(
  options: CredentialSessionOptions | undefined,
): CredentialSessionPolicy {
  if (options === undefined) return DEFAULT_SESSION_POLICY;
  if (typeof options !== "object" || options === null) {
    throw invalid("credential auth sessions must be an object", "sessions");
  }
  const transport = options.transport ?? "bearer";
  if (transport !== "bearer" && transport !== "cookie" && transport !== "both") {
    throw invalid(
      `credential auth sessions.transport must be "bearer", "cookie" or "both"; received ${JSON.stringify(transport)}`,
      "sessions.transport",
    );
  }
  const environment = options.environment ?? "production";
  if (environment !== "development" && environment !== "production") {
    throw invalid(
      'credential auth sessions.environment must be "development" or "production"',
      "sessions.environment",
    );
  }
  if (transport === "bearer") {
    if (options.cookie !== undefined) {
      throw invalid(
        'credential auth sessions.cookie is only meaningful with transport "cookie" or "both"',
        "sessions.cookie",
      );
    }
    return Object.freeze({ ...DEFAULT_SESSION_POLICY, environment });
  }
  const cookie = resolveCookiePolicy(options.cookie ?? {}, environment);
  return Object.freeze({
    transports: Object.freeze(
      transport === "both" ? (["bearer", "cookie"] as const) : (["cookie"] as const),
    ),
    defaultTransport: transport === "both" ? "bearer" : "cookie",
    cookie,
    environment,
  });
}

function resolveCookiePolicy(
  options: CredentialSessionCookieOptions,
  environment: "development" | "production",
): CredentialSessionCookiePolicy {
  if (typeof options !== "object" || options === null) {
    throw invalid("credential auth sessions.cookie must be an object", "sessions.cookie");
  }
  const name = options.name ?? DEFAULT_SESSION_COOKIE_NAME;
  const path = options.path ?? "/";
  const sameSite = options.sameSite ?? "lax";
  const secure = options.secure ?? true;
  const csrfCookieName = options.csrf?.cookieName ?? DEFAULT_CSRF_COOKIE_NAME;
  const csrfHeader = (options.csrf?.header ?? DEFAULT_CSRF_HEADER).toLowerCase();
  for (const [field, value] of [
    ["sessions.cookie.name", name],
    ["sessions.cookie.csrf.cookieName", csrfCookieName],
  ] as const) {
    if (typeof value !== "string" || !COOKIE_NAME_PATTERN.test(value)) {
      throw invalid(`credential auth ${field} must be a valid cookie name`, field);
    }
  }
  if (name === csrfCookieName) {
    throw invalid(
      "credential auth sessions.cookie.csrf.cookieName must differ from the session cookie name",
      "sessions.cookie.csrf.cookieName",
    );
  }
  if (!COOKIE_NAME_PATTERN.test(csrfHeader)) {
    throw invalid(
      "credential auth sessions.cookie.csrf.header must be a valid header name",
      "sessions.cookie.csrf.header",
    );
  }
  if (typeof path !== "string" || !COOKIE_PATH_PATTERN.test(path)) {
    throw invalid(
      "credential auth sessions.cookie.path must be an absolute path",
      "sessions.cookie.path",
    );
  }
  if (
    options.domain !== undefined &&
    (typeof options.domain !== "string" || !COOKIE_DOMAIN_PATTERN.test(options.domain))
  ) {
    throw invalid(
      "credential auth sessions.cookie.domain must be a host name",
      "sessions.cookie.domain",
    );
  }
  if (sameSite !== "lax" && sameSite !== "strict") {
    throw invalid(
      'credential auth sessions.cookie.sameSite must be "lax" or "strict"',
      "sessions.cookie.sameSite",
    );
  }
  if (typeof secure !== "boolean") {
    throw invalid(
      "credential auth sessions.cookie.secure must be a boolean",
      "sessions.cookie.secure",
    );
  }
  if (!secure && environment !== "development") {
    throw invalid(
      'credential auth sessions.cookie.secure: false is only allowed with sessions.environment "development"; a session cookie must not travel over plain HTTP',
      "sessions.cookie.secure",
    );
  }
  for (const cookieName of [name, csrfCookieName]) {
    if (
      cookieName.startsWith("__Host-") &&
      (!secure || path !== "/" || options.domain !== undefined)
    ) {
      throw invalid(
        `credential auth cookie ${JSON.stringify(cookieName)} carries the __Host- prefix, which requires secure: true, path "/" and no domain`,
        "sessions.cookie.name",
      );
    }
    if (cookieName.startsWith("__Secure-") && !secure) {
      throw invalid(
        `credential auth cookie ${JSON.stringify(cookieName)} carries the __Secure- prefix, which requires secure: true`,
        "sessions.cookie.name",
      );
    }
  }
  return Object.freeze({
    name,
    path,
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    sameSite,
    secure,
    csrf: Object.freeze({ cookieName: csrfCookieName, header: csrfHeader }),
  });
}

function attributes(policy: CredentialSessionCookiePolicy, maxAgeSeconds: number): string {
  const parts = [`Path=${policy.path}`];
  if (policy.domain !== undefined) parts.push(`Domain=${policy.domain}`);
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (policy.secure) parts.push("Secure");
  parts.push(`SameSite=${policy.sameSite === "strict" ? "Strict" : "Lax"}`);
  return parts.join("; ");
}

/** The `Set-Cookie` value that installs a session token; `HttpOnly` so script never reads it. */
export function serializeSessionCookie(
  policy: CredentialSessionCookiePolicy,
  token: string,
  maxAgeSeconds: number,
): string {
  if (!COOKIE_VALUE_PATTERN.test(token)) throw new TypeError("session cookie value is not a token");
  return `${policy.name}=${token}; ${attributes(policy, maxAgeSeconds)}; HttpOnly`;
}

/** The `Set-Cookie` value that removes the session cookie (sign-out, revocation). */
export function clearSessionCookie(policy: CredentialSessionCookiePolicy): string {
  return `${policy.name}=; ${attributes(policy, 0)}; HttpOnly`;
}

/** The readable CSRF cookie the client echoes in the CSRF header. */
export function serializeCsrfCookie(
  policy: CredentialSessionCookiePolicy,
  token: string,
  maxAgeSeconds: number,
): string {
  if (!COOKIE_VALUE_PATTERN.test(token)) throw new TypeError("csrf cookie value is not a token");
  return `${policy.csrf.cookieName}=${token}; ${attributes(policy, maxAgeSeconds)}`;
}

/** 256 random bits, base64url, with no prefix: the value is compared, never looked up. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The first cookie of that name in a `Cookie` header, or `undefined`. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** The session token a request carries in the session cookie, when it is at least token-shaped. */
export function readSessionCookie(
  request: Request,
  policy: CredentialSessionCookiePolicy,
): string | undefined {
  return readCookie(request.headers.get("cookie"), policy.name);
}

/**
 * The origin a browser request claims: `Origin`, else the origin of
 * `Referer`. `undefined` when neither is present (a non-browser client);
 * `null` when present but unusable (`Origin: null`, an unparsable referer).
 */
export function requestOrigin(request: Request): string | null | undefined {
  const origin = request.headers.get("origin");
  if (origin !== null) return parseOrigin(origin);
  const referer = request.headers.get("referer");
  if (referer !== null) return parseOrigin(referer);
  return undefined;
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The origin this request was addressed to, honouring the proxy's forwarded
 * scheme and host. A browser sets `Host` itself, so an attacker's page cannot
 * make its `Origin` match it.
 */
export function ownOrigin(request: Request): string | undefined {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto ? `${forwardedProto}:` : url.protocol;
  const host = forwardedHost || request.headers.get("host")?.trim() || url.host;
  if ((protocol !== "https:" && protocol !== "http:") || !host) return undefined;
  return parseOrigin(`${protocol}//${host}`) ?? undefined;
}

export interface CredentialSessionCsrfPolicyOptions {
  /**
   * The module whose sessions the policy protects: its id (for the
   * session-issuing operations), its resolved `sessions` policy (cookie
   * names and attributes) and its `policies.session.maxAgeMs` (the CSRF
   * cookie's lifetime).
   */
  readonly auth: {
    readonly id: string;
    readonly sessions: CredentialSessionPolicy;
    readonly policies: { readonly session: { readonly maxAgeMs: number } };
  };
  /**
   * Browser origins allowed to make state-changing requests with a session
   * cookie: the same list as `cors.origin`. The request's own origin is
   * trusted as well unless `trustOwnOrigin` is `false`.
   */
  readonly trustedOrigins?: readonly string[];
  readonly trustOwnOrigin?: boolean;
  /**
   * Operation ids that issue a session (origin-checked even without a
   * session cookie, against login CSRF). Defaults to the module's sign-in,
   * TOTP verify and recovery consume.
   */
  readonly issuingOperations?: readonly string[];
  readonly generateToken?: () => string;
}

/**
 * The CSRF guard for cookie sessions, as a SAPI-476 pre-validation policy
 * for the `"*"` key of `createHonoAdapter({ preValidationPolicies })`. It
 * runs after actor resolution on every operation, so a refusal is the
 * ADR-0004 403 and never a 500:
 *
 * - safe methods (`GET`, `HEAD`, `OPTIONS`) are exempt;
 * - a request that presents the session cookie (and no bearer header) must
 *   carry a trusted `Origin` (or `Referer`) and echo the CSRF cookie in the
 *   CSRF header, compared in constant time;
 * - a session-issuing operation is refused when it carries an untrusted
 *   `Origin`/`Referer`, so a cross-site form cannot sign the browser into
 *   an attacker's account; a request without either header is a native or
 *   machine client and passes.
 *
 * The policy also installs the readable CSRF cookie on a response to a
 * request that has a session cookie but no CSRF cookie, and on every
 * response of a session-issuing operation, so the client always holds a
 * token to echo after a sign-in or a `GET /auth/me`.
 */
export function credentialSessionCsrfPolicy(
  options: CredentialSessionCsrfPolicyOptions,
): HonoPreValidationPolicy {
  const cookie = options.auth?.sessions?.cookie;
  if (!cookie) {
    throw new TypeError(
      'credentialSessionCsrfPolicy requires a module whose sessions.transport includes "cookie"',
    );
  }
  const trusted = new Set<string>();
  for (const origin of options.trustedOrigins ?? []) {
    const parsed = parseOrigin(origin);
    if (parsed === null) {
      throw new TypeError(
        `credentialSessionCsrfPolicy trustedOrigins entry ${JSON.stringify(origin)} is not an http(s) origin`,
      );
    }
    trusted.add(parsed);
  }
  const trustOwnOrigin = options.trustOwnOrigin ?? true;
  const issuing = new Set(
    options.issuingOperations ?? [
      `${options.auth.id}.sign-in`,
      `${options.auth.id}.totp.verify`,
      `${options.auth.id}.recovery.consume`,
    ],
  );
  const generate = options.generateToken ?? generateCsrfToken;
  const maxAgeSeconds = Math.ceil(options.auth.policies.session.maxAgeMs / 1000);

  const originTrusted = (request: Request, origin: string): boolean =>
    trusted.has(origin) || (trustOwnOrigin && ownOrigin(request) === origin);

  return ({ request, operationId }) => {
    const method = request.method.toUpperCase();
    const cookieHeader = request.headers.get("cookie");
    const hasSessionCookie =
      request.headers.get("authorization") === null &&
      readCookie(cookieHeader, cookie.name) !== undefined;
    const csrfCookie = readCookie(cookieHeader, cookie.csrf.cookieName);
    const issue = csrfCookie === undefined && (hasSessionCookie || issuing.has(operationId));
    const allow = () =>
      issue
        ? ({
            allowed: true,
            headers: { "set-cookie": serializeCsrfCookie(cookie, generate(), maxAgeSeconds) },
          } as const)
        : ({ allowed: true } as const);

    if (SAFE_HTTP_METHODS.has(method)) return allow();
    const origin = requestOrigin(request);
    if (hasSessionCookie) {
      if (origin === undefined || origin === null || !originTrusted(request, origin)) {
        return {
          allowed: false,
          reason: "forbidden",
          message: "The request origin is not trusted for a cookie session",
        };
      }
      const echoed = request.headers.get(cookie.csrf.header);
      if (
        csrfCookie === undefined ||
        echoed === null ||
        !COOKIE_VALUE_PATTERN.test(csrfCookie) ||
        !constantTimeEqualStrings(csrfCookie, echoed)
      ) {
        return {
          allowed: false,
          reason: "forbidden",
          message: "The CSRF token is missing or does not match the CSRF cookie",
        };
      }
      return allow();
    }
    if (issuing.has(operationId) && origin !== undefined) {
      if (origin === null || !originTrusted(request, origin)) {
        return {
          allowed: false,
          reason: "forbidden",
          message: "The request origin is not trusted to sign in",
        };
      }
    }
    return allow();
  };
}
