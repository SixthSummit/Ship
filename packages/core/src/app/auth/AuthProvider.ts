/**
 * `AuthProvider` — pluggable authentication contract.
 *
 * Foundation interface that lets v4.x ship Better-Auth, Clerk, WorkOS, Auth.js,
 * Auth0, WebAuthn/passkeys, and edge-runtime JWKS adapters without breaking the
 * public API. Firebase is the v4.0 default adapter (see `./adapters/firebase`).
 *
 * The shape is intentionally narrow: providers verify a credential and resolve
 * an Account. They do *not* know about HTTP — `requireAuth(...)` middleware is
 * the bridge between Hono `Context` and this interface.
 */

/**
 * Claims extracted from a verified credential. Provider-specific fields go in
 * `metadata` so the `Account` resolver can use them without leaking provider
 * types into the framework.
 */
export interface AuthClaims {
  /** Stable subject identifier from the IdP (e.g., Firebase UID, OIDC `sub`). */
  subject: string;
  /** Optional email if the IdP provides it. */
  email?: string;
  /** Optional verified-email flag if the IdP exposes it. */
  emailVerified?: boolean;
  /** Optional display name. */
  name?: string;
  /** Optional issued-at / expires-at if the IdP exposes them (epoch seconds). */
  issuedAt?: number;
  expiresAt?: number;
  /** Provider-specific extra fields. The Account resolver may consume these. */
  metadata?: Record<string, unknown>;
}

export type AuthVerifyResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; reason: AuthFailureReason; message?: string };

export type AuthFailureReason =
  | "missing-token"
  | "invalid-token"
  | "expired-token"
  | "revoked-token"
  | "issuer-mismatch"
  | "provider-error";

/**
 * Minimal Account interface that the framework requires from any provider's
 * resolved account. Concrete `Account` entities (in `modules/accounts/`)
 * implement this and add their own fields.
 *
 * Kept structural-only here so `AuthProvider` can be defined without depending
 * on the `accounts` module.
 */
export interface AuthenticatedAccount {
  id: string;
  hasPermission?(slug: string): boolean | Promise<boolean>;
}

/**
 * The bridge between a verified credential and a domain Account. Implementations
 * typically look up the Account by `claims.subject`; the optional `onUnknown`
 * field controls whether unknown subjects auto-create an Account.
 */
export interface AccountResolver<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  resolve(claims: AuthClaims): Promise<TAccount | null>;
}

export interface AuthProviderContext {
  /** Raw credential from the request (e.g., `Authorization: Bearer <token>`). */
  rawCredential?: string;
  /** Request headers — providers may read additional fields (e.g., `X-Provider`). */
  headers: Readonly<Record<string, string | undefined>>;
}

export interface AuthProvider<TAccount extends AuthenticatedAccount = AuthenticatedAccount> {
  /** Stable name for logging / multi-provider routing. e.g. "firebase", "clerk". */
  readonly name: string;

  /** Verify a credential and return claims. Pure: must not perform DB lookups. */
  verify(ctx: AuthProviderContext): Promise<AuthVerifyResult>;

  /**
   * Resolve a verified credential to a domain Account. Separate from `verify`
   * so providers can be combined (verify with one, resolve via shared user store).
   */
  resolve(claims: AuthClaims): Promise<TAccount | null>;

  /**
   * Behavior when no credential is present on the request.
   *  - "reject" (default): respond 401 immediately
   *  - "next": continue without an authenticated user (opt-in via `requireAuth({ optional: true })`)
   */
  onMissingToken?: "reject" | "next";

  /**
   * Behavior when a credential verifies but no Account is found.
   *  - "reject" (default): respond 403
   *  - "create": delegate to a hook (provider-specific) to create the Account on first sight
   *  - "next": continue with `claims` only and no Account
   */
  onUnknownAccount?: "reject" | "create" | "next";
}
