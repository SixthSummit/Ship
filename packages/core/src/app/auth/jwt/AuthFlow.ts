import { AuthenticationError } from "../../../http/errors/AuthenticationError.js";
import type { JwtSigner, VerifiedToken } from "./JwtSigner.js";
import {
  generateRefreshTokenValue,
  hashRefreshToken,
  type RefreshTokenStore,
} from "./RefreshTokenStore.js";

/**
 * `AuthFlow` — the policy layer that ties `JwtSigner` and `RefreshTokenStore`
 * together.
 *
 * Implements the framework's stateless cookie-auth flow:
 *
 *   • **Issue** — sign a short-lived access token and mint+persist a long-
 *     lived opaque refresh token. The access JWT carries the account id
 *     plus arbitrary custom claims; the refresh value is a 256-bit random
 *     string whose SHA-256 hash is stored.
 *   • **Verify** — decode and validate an access token via `JwtSigner`. Pure
 *     stateless check — no DB hit.
 *   • **Rotate** — exchange a presented refresh token for a new pair. The
 *     old token's row is marked `replaced_by_id = newRow.id`, all in one
 *     transaction. **Reuse detection**: if the presented token's row already
 *     has `replacedById` set, the entire chain is revoked and the rotation
 *     fails — strong signal of token theft.
 *   • **Revoke** — single-token revocation (e.g., logout) and account-wide
 *     revocation (e.g., password reset, "sign out everywhere").
 */

export interface AuthFlowOptions {
  signer: JwtSigner;
  refreshTokenStore: RefreshTokenStore;
  /** Access-token TTL in seconds. Defaults to 15 minutes. */
  accessTokenTtlSec?: number;
  /** Refresh-token TTL in seconds. Defaults to 30 days. */
  refreshTokenTtlSec?: number;
}

export interface IssueAuthInput {
  /** Account ID — written to the access token's `sub` and the refresh row's `accountId`. */
  accountId: string;
  /** Optional custom claims on the access token. */
  claims?: Record<string, unknown>;
  /** Audit context — User-Agent and IP are persisted on the refresh row. */
  userAgent?: string;
  ip?: string;
}

export interface AuthTokenPair {
  /** Compact JWS access token. */
  accessToken: string;
  /** Opaque refresh token (raw, base64url-encoded random bytes). */
  refreshToken: string;
  /** Access-token expiry (epoch seconds). */
  accessTokenExpiresAt: number;
  /** Refresh-token expiry (epoch seconds). */
  refreshTokenExpiresAt: number;
  /** Refresh row's id — useful for log correlation, never sent to clients. */
  refreshTokenId: string;
}

const DEFAULT_ACCESS_TTL_SEC = 15 * 60;
const DEFAULT_REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

export class AuthFlow {
  private readonly signer: JwtSigner;
  private readonly store: RefreshTokenStore;
  private readonly accessTtlSec: number;
  private readonly refreshTtlSec: number;

  constructor(opts: AuthFlowOptions) {
    this.signer = opts.signer;
    this.store = opts.refreshTokenStore;
    this.accessTtlSec = opts.accessTokenTtlSec ?? DEFAULT_ACCESS_TTL_SEC;
    this.refreshTtlSec = opts.refreshTokenTtlSec ?? DEFAULT_REFRESH_TTL_SEC;
  }

  /**
   * Issue a fresh access+refresh pair. Used at login and at first sign-in
   * after a successful third-party auth (e.g., OAuth callback).
   */
  async issue(input: IssueAuthInput): Promise<AuthTokenPair> {
    const access = await this.signer.sign({
      subject: input.accountId,
      ttlSec: this.accessTtlSec,
      claims: input.claims,
    });

    const refreshRaw = generateRefreshTokenValue();
    const refreshHash = hashRefreshToken(refreshRaw);
    const refreshExpiresAt = new Date((Math.floor(Date.now() / 1000) + this.refreshTtlSec) * 1000);

    const refreshRow = await this.store.issue({
      accountId: input.accountId,
      tokenHash: refreshHash,
      expiresAt: refreshExpiresAt,
      userAgent: input.userAgent,
      issuedFromIp: input.ip,
    });

    return {
      accessToken: access.token,
      refreshToken: refreshRaw,
      accessTokenExpiresAt: access.expiresAt,
      refreshTokenExpiresAt: Math.floor(refreshExpiresAt.getTime() / 1000),
      refreshTokenId: refreshRow.id,
    };
  }

  /**
   * Verify an access token. Stateless — does not touch the refresh-token
   * store. Throws `AuthenticationError` on signature, expiry, or claim
   * validation failure.
   */
  async verifyAccess(token: string): Promise<VerifiedToken> {
    return this.signer.verify(token);
  }

  /**
   * Exchange a presented refresh token for a new pair. **Reuse detection**:
   * if the row is already revoked OR already has `replacedById` set, the
   * entire chain is revoked and the call throws. This is a load-bearing
   * security property — a stolen-and-then-original-also-presented refresh
   * token kills the session for both attacker and legitimate user.
   */
  async rotate(
    presentedRefreshToken: string,
    audit: { userAgent?: string; ip?: string } = {},
  ): Promise<AuthTokenPair> {
    const tokenHash = hashRefreshToken(presentedRefreshToken);
    const row = await this.store.findByHash(tokenHash);
    if (!row) {
      throw new AuthenticationError("Refresh token invalid");
    }

    if (row.revokedAt) {
      // Revoked tokens that get re-presented are a theft signal too — kill the chain.
      await this.store.revokeChain(row.id);
      throw new AuthenticationError("Refresh token revoked");
    }

    if (row.replacedById) {
      // The strongest reuse signal: the legitimate user already rotated this
      // token, but someone (legitimate or attacker) re-presented the old value.
      // Either way, kill the session.
      await this.store.revokeChain(row.id);
      throw new AuthenticationError("Refresh token reuse detected — session revoked");
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AuthenticationError("Refresh token expired");
    }

    // Mint the successor.
    const newAccess = await this.signer.sign({
      subject: row.accountId,
      ttlSec: this.accessTtlSec,
    });
    const newRefreshRaw = generateRefreshTokenValue();
    const newRefreshHash = hashRefreshToken(newRefreshRaw);
    const newRefreshExpiresAt = new Date(
      (Math.floor(Date.now() / 1000) + this.refreshTtlSec) * 1000,
    );

    const newRow = await this.store.rotate(row.id, {
      accountId: row.accountId,
      tokenHash: newRefreshHash,
      expiresAt: newRefreshExpiresAt,
      userAgent: audit.userAgent,
      issuedFromIp: audit.ip,
    });

    return {
      accessToken: newAccess.token,
      refreshToken: newRefreshRaw,
      accessTokenExpiresAt: newAccess.expiresAt,
      refreshTokenExpiresAt: Math.floor(newRefreshExpiresAt.getTime() / 1000),
      refreshTokenId: newRow.id,
    };
  }

  /**
   * Revoke a single refresh token. Idempotent — already-revoked tokens are
   * a no-op. Used at logout. The call is forgiving by design: an attacker
   * presenting an unknown token shouldn't get a different response from
   * one presenting a valid token.
   */
  async revoke(presentedRefreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(presentedRefreshToken);
    const row = await this.store.findByHash(tokenHash);
    if (!row) return;
    if (row.revokedAt) return;
    await this.store.revoke(row.id);
  }

  /**
   * Revoke every active refresh token for an account. Used at password
   * reset, "sign out everywhere", and admin-driven session termination.
   * Returns the number of tokens revoked for log correlation.
   */
  async revokeAccount(accountId: string): Promise<number> {
    return this.store.revokeAllForAccount(accountId);
  }
}
