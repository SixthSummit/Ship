import admin from "firebase-admin";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthFailureReason,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "../AuthProvider.js";

/**
 * Firebase `AuthProvider` adapter — the v4.0 default.
 *
 * Wraps `firebase-admin`'s `verifyIdToken` and a consumer-supplied account-lookup
 * callback. Lives at the framework level so it has no opinion about persistence
 * (TypeORM v3, Drizzle v4) — the consumer wires the lookup. This keeps the
 * adapter testable in isolation and lets the same code work across the v3 → v4
 * transition.
 *
 * Ports today's `JwtAuthMiddleware` token-verification behavior into the v4
 * `AuthProvider` interface without changing semantics:
 *   - Reads `Authorization: Bearer <id-token>` (and `X-Forwarded-Authorization`).
 *   - Calls `admin.auth().verifyIdToken(token)` with `checkRevoked` opt-in.
 *   - Maps verification errors to `AuthFailureReason` codes so the framework
 *     can surface them consistently in `requireAuth`'s 401 responses.
 *   - Looks up the domain `Account` via the supplied `findAccount` callback.
 */

export interface FirebaseAuthClaimsExtras {
  /** Firebase project ID the token was issued for. */
  audience?: string;
  /** Token issuer (`https://securetoken.google.com/<project-id>`). */
  issuer?: string;
  /** Identity provider used to sign the user in (e.g., `password`, `google.com`). */
  signInProvider?: string;
  /** Whether Firebase considers the email verified at token issue time. */
  firebaseEmailVerified?: boolean;
}

export interface FirebaseAuthProviderOptions<
  TAccount extends AuthenticatedAccount = AuthenticatedAccount,
> {
  /**
   * Look up the domain Account from a verified Firebase UID. Returns `null` if
   * no Account is registered. Consumers supply this — the framework does not
   * assume an ORM. Hooked into TypeORM in v3 transition; Drizzle in v4.
   */
  findAccount: (firebaseUid: string, claims: AuthClaims) => Promise<TAccount | null>;

  /**
   * If `true`, calls `verifyIdToken(token, true)` to also reject revoked tokens.
   * Costs one extra Firestore RTT per request on cold paths. Default `false`.
   */
  checkRevoked?: boolean;

  /**
   * Behavior when no credential is on the request. Default `"reject"` — the v3
   * silent fall-through becomes opt-in via `requireAuth({ optional: true })`.
   */
  onMissingToken?: "reject" | "next";

  /**
   * Behavior when a token verifies but no Account is registered for that UID.
   * Default `"reject"` (403). Use `"next"` for endpoints that should serve
   * unauthenticated traffic with degraded data.
   */
  onUnknownAccount?: "reject" | "create" | "next";

  /**
   * Optional override for token extraction. Default reads
   * `X-Forwarded-Authorization` then `Authorization`, both `Bearer <token>`.
   */
  extractToken?: (ctx: AuthProviderContext) => string | undefined;

  /**
   * Optional Firebase Admin app override (for multi-project scenarios or tests).
   * Falls back to the default `admin` app when not provided.
   */
  firebaseApp?: admin.app.App;
}

const BEARER_PREFIX = /^Bearer\s+/i;

function defaultExtractToken(ctx: AuthProviderContext): string | undefined {
  const direct = ctx.rawCredential?.replace(BEARER_PREFIX, "").trim();
  if (direct) return direct;

  // `X-Forwarded-Authorization` — used when behind a Cloud Run / Cloudflare /
  // GCP IAP proxy that has consumed the original `Authorization` header.
  const forwarded = ctx.headers["x-forwarded-authorization"]?.replace(BEARER_PREFIX, "").trim();
  if (forwarded) return forwarded;

  const auth = ctx.headers["authorization"]?.replace(BEARER_PREFIX, "").trim();
  if (auth) return auth;

  return undefined;
}

interface FirebaseAuthErrorLike {
  code?: string;
  message?: string;
}

function classifyFirebaseError(err: unknown): { reason: AuthFailureReason; message: string } {
  const e = err as FirebaseAuthErrorLike;
  const code = e?.code ?? "";
  const message = e?.message ?? "Token verification failed";

  if (code.includes("id-token-expired")) return { reason: "expired-token", message };
  if (code.includes("id-token-revoked")) return { reason: "revoked-token", message };
  if (code.includes("argument-error")) return { reason: "invalid-token", message };
  if (code.includes("invalid-id-token")) return { reason: "invalid-token", message };
  if (code.includes("audience-mismatch") || code.includes("issuer-mismatch")) {
    return { reason: "issuer-mismatch", message };
  }
  return { reason: "provider-error", message };
}

function decodedTokenToClaims(decoded: admin.auth.DecodedIdToken): AuthClaims {
  const claims: AuthClaims = {
    subject: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified,
    name: decoded.name,
    issuedAt: decoded.iat,
    expiresAt: decoded.exp,
  };

  const extras: FirebaseAuthClaimsExtras = {
    audience: decoded.aud,
    issuer: decoded.iss,
    signInProvider: decoded.firebase?.sign_in_provider,
    firebaseEmailVerified: decoded.email_verified,
  };

  // Pass the full decoded token through `metadata` for advanced consumers
  // (custom claims, sign-in provider, tenant). Stable enough that v4.x
  // adapters can consume it without provider-specific imports.
  claims.metadata = {
    firebase: extras,
    customClaims: extractCustomClaims(decoded),
  };

  return claims;
}

function extractCustomClaims(decoded: admin.auth.DecodedIdToken): Record<string, unknown> {
  // Firebase puts custom claims at the top level of the decoded token alongside
  // standard JWT fields. Strip the standard fields out so consumers see only
  // the actual custom claims.
  const standard = new Set([
    "uid",
    "email",
    "email_verified",
    "name",
    "picture",
    "iss",
    "aud",
    "auth_time",
    "user_id",
    "sub",
    "iat",
    "exp",
    "firebase",
  ]);
  const custom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
    if (!standard.has(key)) custom[key] = value;
  }
  return custom;
}

export class FirebaseAuthProvider<TAccount extends AuthenticatedAccount = AuthenticatedAccount>
  implements AuthProvider<TAccount>
{
  readonly name = "firebase";
  readonly onMissingToken: "reject" | "next";
  readonly onUnknownAccount: "reject" | "create" | "next";

  private readonly opts: FirebaseAuthProviderOptions<TAccount>;
  private readonly extractToken: (ctx: AuthProviderContext) => string | undefined;

  constructor(opts: FirebaseAuthProviderOptions<TAccount>) {
    this.opts = opts;
    this.onMissingToken = opts.onMissingToken ?? "reject";
    this.onUnknownAccount = opts.onUnknownAccount ?? "reject";
    this.extractToken = opts.extractToken ?? defaultExtractToken;
  }

  async verify(ctx: AuthProviderContext): Promise<AuthVerifyResult> {
    const token = this.extractToken(ctx);
    if (!token) {
      return { ok: false, reason: "missing-token", message: "No bearer token on request" };
    }

    const auth = this.opts.firebaseApp ? this.opts.firebaseApp.auth() : admin.auth();

    try {
      const decoded = await auth.verifyIdToken(token, this.opts.checkRevoked === true);
      return { ok: true, claims: decodedTokenToClaims(decoded) };
    } catch (err) {
      const { reason, message } = classifyFirebaseError(err);
      return { ok: false, reason, message };
    }
  }

  async resolve(claims: AuthClaims): Promise<TAccount | null> {
    return this.opts.findAccount(claims.subject, claims);
  }
}

/**
 * Convenience factory matching the documented `firebaseAuth({ ... })` API in
 * the plan's §F.
 */
export function firebaseAuth<TAccount extends AuthenticatedAccount = AuthenticatedAccount>(
  opts: FirebaseAuthProviderOptions<TAccount>,
): FirebaseAuthProvider<TAccount> {
  return new FirebaseAuthProvider(opts);
}
