import { AUTH_COOKIE_NAMES } from "../../../http/utils/authCookies.js";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "../AuthProvider.js";
import type { JwtSigner } from "../jwt/JwtSigner.js";

/**
 * `jwtCookieAuth` — `AuthProvider` adapter for the framework's stateless cookie
 * auth flow (the v4.0 default for first-party clients).
 *
 * Plugs into the same `requireAuth({ provider })` middleware that the Firebase
 * adapter does, so internal-only ShipAPI deployments can use cookie auth and
 * external/partner deployments can use Firebase IdTokens (or any v4.x adapter)
 * without changing the middleware contract.
 *
 * Verification flow:
 *   1. Read the access cookie (`ship_access` by default; configurable).
 *   2. Verify the JWS via `JwtSigner.verify()` — signature, expiry, issuer,
 *      audience all validated, with `kid`-based key rotation supported.
 *   3. Resolve the domain `Account` via the consumer-supplied `findAccount`
 *      callback (mirrors `FirebaseAuthProvider`'s shape).
 *
 * The `claims.subject` is taken from the JWT's `sub` claim — populated by
 * `AuthFlow.issue()` with the `accountId`. Custom claims threaded into the
 * token via `AuthFlow.issue({ claims })` surface in `AuthClaims.metadata`.
 */

export interface JwtCookieAuthProviderOptions<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
> {
  /** The framework's `JwtSigner` (typically obtained from `AuthFlow`). */
  signer: JwtSigner;
  /**
   * Resolve a domain Account from the verified JWT's claims. Mirrors
   * `FirebaseAuthProvider.findAccount` — consumers wire this to their account
   * lookup. Returns `null` if no account exists.
   */
  findAccount: (accountId: string, claims: AuthClaims) => Promise<TAccount | null>;
  /** Override the access cookie name. Default `"ship_access"`. */
  cookieName?: string;
  /** Provider behavior when no cookie is present. Default `"reject"`. */
  onMissingToken?: "reject" | "next";
  /** Provider behavior when JWT verifies but no account resolves. Default `"reject"`. */
  onUnknownAccount?: "reject" | "create" | "next";
}

export class JwtCookieAuthProvider<TAccount extends AuthenticatedAccount = AuthenticatedAccount>
  implements AuthProvider<TAccount>
{
  readonly name = "jwt-cookie";
  readonly onMissingToken: "reject" | "next";
  readonly onUnknownAccount: "reject" | "create" | "next";

  private readonly signer: JwtSigner;
  private readonly findAccount: JwtCookieAuthProviderOptions<TAccount>["findAccount"];
  private readonly cookieName: string;

  constructor(opts: JwtCookieAuthProviderOptions<TAccount>) {
    this.signer = opts.signer;
    this.findAccount = opts.findAccount;
    this.cookieName = opts.cookieName ?? AUTH_COOKIE_NAMES.access;
    this.onMissingToken = opts.onMissingToken ?? "reject";
    this.onUnknownAccount = opts.onUnknownAccount ?? "reject";
  }

  async verify(ctx: AuthProviderContext): Promise<AuthVerifyResult> {
    const token = readCookieFromHeaders(ctx.headers, this.cookieName);
    if (!token) {
      return { ok: false, reason: "missing-token", message: "No access cookie on request" };
    }

    try {
      const verified = await this.signer.verify(token);
      const claims = jwtPayloadToClaims(verified.payload);
      return { ok: true, claims };
    } catch (err) {
      // `JwtSigner.verify` throws `AuthenticationError` with a normalized
      // message. Map common cases back into the `AuthFailureReason` taxonomy
      // so `requireAuth` can format consistently across providers.
      const msg = (err as Error).message ?? "Token verification failed";
      if (msg.includes("expired")) return { ok: false, reason: "expired-token", message: msg };
      if (msg.includes("revoked")) return { ok: false, reason: "revoked-token", message: msg };
      if (msg.includes("kid") || msg.includes("signing key")) {
        return { ok: false, reason: "invalid-token", message: msg };
      }
      if (msg.includes("claim")) return { ok: false, reason: "issuer-mismatch", message: msg };
      return { ok: false, reason: "invalid-token", message: msg };
    }
  }

  async resolve(claims: AuthClaims): Promise<TAccount | null> {
    return this.findAccount(claims.subject, claims);
  }
}

/**
 * Convenience factory — matches the documented `jwtCookieAuth({ ... })` shape
 * in §F of the plan, parallel to `firebaseAuth({ ... })`.
 */
export function jwtCookieAuth<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  opts: JwtCookieAuthProviderOptions<TAccount>,
): JwtCookieAuthProvider<TAccount> {
  return new JwtCookieAuthProvider(opts);
}

function readCookieFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  cookieName: string,
): string | undefined {
  const header = headers["cookie"];
  if (!header) return undefined;
  // Minimal parser — Hono's `getCookie` does the same thing but expects a
  // `Context`. We only have raw headers in `AuthProviderContext`, so parse
  // here. Cookies are `name=value; name2=value2` — values may contain `=`
  // for base64url so we split on the first `=` only.
  const target = `${cookieName}=`;
  for (const segment of header.split(";")) {
    const trimmed = segment.trimStart();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      // Cookie values are not URL-encoded by `setCookie` for typical tokens
      // (base64url is cookie-safe), but be defensive.
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

function jwtPayloadToClaims(payload: Record<string, unknown>): AuthClaims {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT missing `sub` claim — refusing to resolve account");
  }
  const claims: AuthClaims = {
    subject: sub,
    issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
    expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
  };
  if (typeof payload.email === "string") claims.email = payload.email;
  if (typeof payload.email_verified === "boolean") {
    claims.emailVerified = payload.email_verified;
  }
  if (typeof payload.name === "string") claims.name = payload.name;

  // Pass through extra fields under `metadata.custom` for downstream consumers
  // (e.g., role/tenant claims threaded by AuthFlow.issue({ claims })).
  const standard = new Set([
    "sub",
    "iat",
    "exp",
    "iss",
    "aud",
    "jti",
    "nbf",
    "email",
    "email_verified",
    "name",
  ]);
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!standard.has(key)) custom[key] = value;
  }
  if (Object.keys(custom).length > 0) {
    claims.metadata = { custom };
  }
  return claims;
}
