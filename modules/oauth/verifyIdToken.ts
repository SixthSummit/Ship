import { AuthenticationError } from "@sixthsummit/ship-api/http/errors/AuthenticationError";
import type { JWTPayload, JWTVerifyOptions } from "jose";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

/**
 * Key resolver accepted by `jose.jwtVerify` — a literal key, a
 * `JWKSet` instance returned from `createRemoteJWKSet` /
 * `createLocalJWKSet`, or a callable that yields one per JWS
 * header.
 */
export type IdTokenKeyInput = Parameters<typeof jwtVerify>[1];

/**
 * `verifyIdToken` — OIDC `id_token` verification helper (F13).
 *
 * **`@internal` — no adapter currently consumes `id_token` as an
 * identity decision.** The existing adapters resolve the provider
 * account id via `/userinfo` over a Bearer-authenticated access
 * token, not via id_token claims. This helper exists so any future
 * code path that promotes id_token claims to identity decisions
 * (e.g. `email_verified`, `sub` lookup without a userinfo round-trip)
 * MUST route through it instead of decoding the JWT directly.
 *
 * Verifies, in order:
 *   1. Signature against the provider's JWKS (RS256 / ES256 — `jose`
 *      picks the algorithm from the JWS header).
 *   2. `iss` (issuer) matches `expectedIssuer`.
 *   3. `aud` (audience) matches `expectedAudience`.
 *   4. `exp` / `nbf` / `iat` against the current clock (configurable
 *      tolerance, default 30s — matches `JwtSigner`'s P0-F9 default).
 *   5. `nonce` claim equals `expectedNonce` (constant-time string
 *      compare). This is the defense the helper is named for: without
 *      a nonce check, an attacker who captures a victim's id_token in
 *      one OIDC flow can replay it into a separate framework-initiated
 *      flow to impersonate the victim's identity decision.
 *
 * Throws `AuthenticationError` on any failure — caller surfaces this
 * through the framework's standard error path.
 *
 * JWKS fetches are cached per-URI inside the module (`jose`'s
 * `createRemoteJWKSet` does this internally — same `URL` value
 * resolves to the same JWKS instance across the process lifetime).
 *
 * Future call-site contract: any code path that promotes id_token
 * claims to a security decision (account lookup, `email_verified`
 * gating, role assignment) MUST call this helper with the nonce
 * the framework signed into state for the originating flow. The
 * routes layer already round-trips a `nonce` field in the signed
 * `StatePayload` — wire the nonce echo there when an adapter
 * actually consumes id_token.
 */

export interface VerifyIdTokenOptions {
  /** Raw id_token JWS (`xxxx.yyyy.zzzz`). */
  idToken: string;
  /**
   * Provider's JWKS endpoint URL (e.g. `https://www.googleapis.com/oauth2/v3/certs`)
   * **OR** a pre-built key/JWKS resolver from `jose`. Production
   * code typically passes the URL string; tests + advanced callers
   * pass a `createLocalJWKSet({ keys: [...] })` or a literal
   * `CryptoKey` to avoid the network round-trip.
   *
   * When a URL string is supplied, the helper memoizes the
   * `createRemoteJWKSet` instance per URL across the process so
   * repeated calls against the same provider don't refetch keys per
   * request.
   */
  key: string | IdTokenKeyInput;
  /**
   * Nonce echoed from the framework-signed OAuth state. Compared
   * against the JWT's `nonce` claim. Required — passing an empty
   * string is a configuration error and rejects every token.
   */
  expectedNonce: string;
  /**
   * Expected `iss` claim (e.g. `https://accounts.google.com`,
   * `https://login.microsoftonline.com/<tenant>/v2.0`). The provider
   * documents the exact issuer string.
   */
  expectedIssuer: string;
  /**
   * Expected `aud` claim — typically the OAuth client_id for which
   * the token was minted.
   */
  expectedAudience: string;
  /**
   * Clock-skew tolerance in seconds. Default 30 — matches `JwtSigner`'s
   * post-F9 default and NIST SP 800-63B §5.1.1.2 guidance.
   */
  clockToleranceSec?: number;
}

const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

const jwksCache: Map<string, ReturnType<typeof createRemoteJWKSet>> = new Map();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(uri);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(uri));
  jwksCache.set(uri, set);
  return set;
}

/**
 * Constant-time string equality. Both inputs must be the same length
 * to avoid early-return timing leaks. Mismatched lengths return false
 * immediately — the nonce we generate is a fixed-length base64url
 * value, so an attacker who supplies a shorter or longer string
 * always loses on length alone.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyIdToken(opts: VerifyIdTokenOptions): Promise<JWTPayload> {
  if (!opts.idToken) throw new AuthenticationError("verifyIdToken: missing idToken");
  if (!opts.expectedNonce) {
    throw new AuthenticationError("verifyIdToken: expectedNonce is required");
  }
  if (!opts.expectedIssuer) {
    throw new AuthenticationError("verifyIdToken: expectedIssuer is required");
  }
  if (!opts.expectedAudience) {
    throw new AuthenticationError("verifyIdToken: expectedAudience is required");
  }

  const key: IdTokenKeyInput = typeof opts.key === "string" ? jwksFor(opts.key) : opts.key;
  const verifyOpts: JWTVerifyOptions = {
    issuer: opts.expectedIssuer,
    audience: opts.expectedAudience,
    clockTolerance: opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC,
  };

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(opts.idToken, key, verifyOpts);
    payload = result.payload;
  } catch (err) {
    throw classifyVerifyError(err);
  }

  const nonceClaim = payload.nonce;
  if (typeof nonceClaim !== "string" || nonceClaim.length === 0) {
    throw new AuthenticationError("verifyIdToken: id_token missing nonce claim");
  }
  if (!constantTimeStringEqual(nonceClaim, opts.expectedNonce)) {
    throw new AuthenticationError("verifyIdToken: nonce mismatch");
  }

  return payload;
}

function classifyVerifyError(err: unknown): AuthenticationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new AuthenticationError("verifyIdToken: id_token expired");
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return new AuthenticationError(`verifyIdToken: claim invalid (${err.claim})`);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new AuthenticationError("verifyIdToken: signature verification failed");
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new AuthenticationError("verifyIdToken: no matching JWKS key");
  }
  return new AuthenticationError(
    `verifyIdToken: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Exposed for tests; do not depend on this outside the framework. */
export const _internals = { jwksCache, DEFAULT_CLOCK_TOLERANCE_SEC };
