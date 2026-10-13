import { randomUUID } from "node:crypto";
import { type CryptoKey, type JWTPayload, errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { AuthenticationError } from "../../../http/errors/AuthenticationError.js";

/**
 * `JwtSigner` — ES256 JWT signing/verification with `kid`-based key rotation.
 *
 * Wraps `jose@^6` for the framework's stateless cookie-auth flow. Owned by
 * `AuthFlow` (which combines this with `RefreshTokenStore` to handle issue /
 * rotate / revoke). Lives at this level because:
 *
 *   1. **Key rotation is a load-bearing security primitive.** A signer that
 *      can verify with multiple public keys lets operators add a new key,
 *      cut signing over to it, wait for max-token-lifetime, then retire the
 *      old key — without forcing every active session to re-authenticate.
 *      The rotation procedure is documented in `.cursor/rules/security.mdc`.
 *
 *   2. **Edge-runtime parity.** `CryptoKey` (Web Crypto) is portable between
 *      Node, Cloudflare Workers, and Bun, so v4.x edge adapters reuse this
 *      class without a runtime fork.
 *
 *   3. **Pluggable adapter boundary.** `AuthFlow` owns persistence (refresh
 *      token store) and HTTP (cookies); `JwtSigner` owns *only* the JWS step.
 *      Easier to test, easier to swap (e.g., HSM-backed signer in v4.x).
 *
 * The single signing key (`signingKey.kid`) is the active key; tokens carry
 * the `kid` in their protected header. Verification looks the `kid` up in the
 * `verificationKeys` map, which always includes the active signing key plus
 * any retiring keys still inside their max-lifetime grace window.
 */

export interface JwtSigningKey {
  /** Key identifier — propagated into the token's `kid` header. */
  kid: string;
  /** Web Crypto private key for ES256. Use jose's `importPKCS8(pem, 'ES256')`. */
  privateKey: CryptoKey;
}

export interface JwtVerificationKey {
  kid: string;
  /** Web Crypto public key for ES256. Use jose's `importSPKI(pem, 'ES256')`. */
  publicKey: CryptoKey;
}

export interface JwtSignerOptions {
  /** Active signing key. Tokens are issued with `protectedHeader.kid = signingKey.kid`. */
  signingKey: JwtSigningKey;
  /**
   * All public keys currently accepted at verification time. MUST include
   * `signingKey`'s public counterpart and any retiring keys within their
   * grace window. Empty arrays are rejected at construction.
   */
  verificationKeys: JwtVerificationKey[];
  /** Default `iss` claim on signed tokens; verified at decode time. */
  issuer?: string;
  /** Default `aud` claim on signed tokens; verified at decode time. */
  audience?: string;
  /**
   * Clock-skew tolerance for `exp`/`nbf`/`iat` validation in seconds.
   *
   * **Default 30** — the industry-standard tolerance per NIST SP
   * 800-63B §5.1.1.2. Tight enough to defend against meaningful
   * replay (the access-token TTL is the dominant window) and broad
   * enough to survive the ~1–5 s NTP drift typical between hosts
   * with healthy clock-sync. A 0 default produced flaky 401s in
   * mixed environments and pushed adopters toward minutes-long
   * tolerances that weakened the contract further than necessary.
   *
   * Explicit `clockToleranceSec: 0` reproduces the prior strict
   * behavior for callers who genuinely want zero slack.
   */
  clockToleranceSec?: number;
}

export interface SignTokenOptions {
  /** Subject (`sub`) — typically the Account ID. */
  subject: string;
  /** TTL in seconds. Required to force callers to make an explicit decision. */
  ttlSec: number;
  /** Optional explicit `jti`. Auto-generated as a UUIDv4 when omitted. */
  jti?: string;
  /** Optional override of the construction-time `iss`. */
  issuer?: string;
  /** Optional override of the construction-time `aud`. */
  audience?: string;
  /** Custom claims merged into the JWT payload. Avoid colliding with reserved names. */
  claims?: Record<string, unknown>;
}

export interface SignedToken {
  /** Compact JWS string (`xxxx.yyyy.zzzz`). */
  token: string;
  /** UUID issued for this token; persisted by `AuthFlow` for refresh-token revocation. */
  jti: string;
  /** Epoch seconds at issue time. */
  issuedAt: number;
  /** Epoch seconds at expiry. */
  expiresAt: number;
  /** Key id used to sign — useful for log correlation during rotation. */
  kid: string;
}

export interface VerifiedToken<TClaims extends JWTPayload = JWTPayload> {
  payload: TClaims;
  kid: string;
}

const ALG = "ES256" as const;

export class JwtSigner {
  private readonly signingKey: JwtSigningKey;
  private readonly verificationKeysByKid: Map<string, CryptoKey>;
  private readonly issuer?: string;
  private readonly audience?: string;
  private readonly clockToleranceSec: number;

  constructor(opts: JwtSignerOptions) {
    if (!opts.verificationKeys.length) {
      throw new Error("JwtSigner: verificationKeys must contain at least one key");
    }
    this.signingKey = opts.signingKey;
    this.verificationKeysByKid = new Map();
    for (const key of opts.verificationKeys) {
      if (this.verificationKeysByKid.has(key.kid)) {
        throw new Error(`JwtSigner: duplicate verification key kid "${key.kid}"`);
      }
      this.verificationKeysByKid.set(key.kid, key.publicKey);
    }
    if (!this.verificationKeysByKid.has(opts.signingKey.kid)) {
      throw new Error(
        `JwtSigner: signing key kid "${opts.signingKey.kid}" missing from verificationKeys`,
      );
    }
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.clockToleranceSec = opts.clockToleranceSec ?? 30;
  }

  /**
   * Sign a token. The caller is responsible for choosing `ttlSec` (e.g., 15m
   * for access tokens, 30d for refresh tokens). Returns the compact JWS plus
   * metadata `AuthFlow` needs to persist a `refresh_tokens` row.
   */
  async sign(opts: SignTokenOptions): Promise<SignedToken> {
    const jti = opts.jti ?? randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + opts.ttlSec;

    const builder = new SignJWT({ ...(opts.claims ?? {}) })
      .setProtectedHeader({ alg: ALG, kid: this.signingKey.kid })
      .setSubject(opts.subject)
      .setJti(jti)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt);

    const issuer = opts.issuer ?? this.issuer;
    if (issuer) builder.setIssuer(issuer);
    const audience = opts.audience ?? this.audience;
    if (audience) builder.setAudience(audience);

    const token = await builder.sign(this.signingKey.privateKey);

    return { token, jti, issuedAt, expiresAt, kid: this.signingKey.kid };
  }

  /**
   * Verify a token. Throws `AuthenticationError` on any failure — caller
   * surfaces this through the framework's standard error path. Signature,
   * expiry, and (when configured) issuer/audience are all enforced.
   */
  async verify<TClaims extends JWTPayload = JWTPayload>(
    token: string,
  ): Promise<VerifiedToken<TClaims>> {
    try {
      const result = await jwtVerify<TClaims>(token, (header) => this.resolveKey(header.kid), {
        algorithms: [ALG],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSec,
      });
      const kid = result.protectedHeader.kid ?? this.signingKey.kid;
      return { payload: result.payload, kid };
    } catch (err) {
      throw classifyVerificationError(err);
    }
  }

  /** Expose the active signing kid for log/metric correlation. */
  getSigningKid(): string {
    return this.signingKey.kid;
  }

  /** Expose the kids currently accepted at verification — useful for `/dev/routes`-style introspection. */
  getVerificationKids(): string[] {
    return [...this.verificationKeysByKid.keys()];
  }

  private resolveKey(kid: string | undefined): CryptoKey {
    if (!kid) {
      // We always sign with a `kid` header, so an unsigned token is a forgery
      // attempt against this verifier.
      throw new joseErrors.JWSInvalid("Token missing kid header");
    }
    const key = this.verificationKeysByKid.get(kid);
    if (!key) {
      throw new joseErrors.JWKSNoMatchingKey();
    }
    return key;
  }
}

function classifyVerificationError(err: unknown): AuthenticationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new AuthenticationError("Token expired");
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return new AuthenticationError(`Token claim invalid: ${err.claim}`);
  }
  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new AuthenticationError("Token signing key not recognized");
  }
  if (err instanceof joseErrors.JWSInvalid) {
    // Forwards messages like "Token missing kid header" set in `resolveKey`.
    return new AuthenticationError(err.message || "Token signature invalid");
  }
  if (err instanceof joseErrors.JOSEError) {
    return new AuthenticationError("Token verification failed");
  }
  // Unknown/unexpected — surface as generic auth failure but preserve cause
  // so OTel/pino can capture the stack.
  const auth = new AuthenticationError("Token verification failed");
  (auth as Error & { cause?: unknown }).cause = err;
  return auth;
}
