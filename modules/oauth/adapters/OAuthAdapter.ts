/**
 * v4 OAuth provider adapter contract.
 *
 * Provider-specific quirks (Google's `prompt=consent` to force refresh-
 * token reissue, Microsoft's tenant-aware authority URL, Gmail's
 * scope-narrowing helpers) live behind concrete adapter implementations;
 * the framework only sees this interface.
 *
 * Adapters MUST:
 *   - Build a provider-compatible authorization URL with the supplied
 *     `state` opaque (the framework signs / verifies state — adapters
 *     just round-trip the string).
 *   - Exchange an authorization code for tokens using only the standard
 *     `OAuthClientCredentials` shape — no globals, no env reads.
 *   - Refresh tokens via the provider's documented refresh-token flow.
 *   - Return a `TokenResponse` that maps cleanly to the schema columns:
 *     `accessToken`, `refreshToken?`, `expiresAt?`, `scope?`,
 *     `tokenType?`, `metadata?`. Provider extras land in `metadata`.
 *   - Throw `OAuthAdapterError` (subclassed appropriately) on
 *     translation failures so the routes layer can map to AppError /
 *     status codes consistently.
 *
 * Adapters SHOULD:
 *   - Accept an injected `fetch` in their constructor so tests can
 *     swap it without monkey-patching globals.
 *   - Be fetch-based when possible — no axios / SDK requirements when
 *     the OAuth flow is plain HTTP. SDK-backed adapters (e.g.
 *     `googleapis`) declare the SDK as an optional dep so consumers
 *     who don't use those adapters don't pay for them.
 *
 * The interface deliberately differs from v3's
 * `IOAuthProviderAdapter` in two ways:
 *   - State is an opaque string the framework owns end-to-end (signs +
 *     verifies + binds to user). v3 had adapters JSON-encode `userId`
 *     into state, mixing concerns; v4 keeps state opaque.
 *   - `userId: bigint` parameter is gone. The framework holds the user
 *     identity; adapters never see it. That's a security property —
 *     v3's adapters could in principle leak userId into provider
 *     telemetry by encoding it into URLs they construct.
 */

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthUrlOptions {
  /**
   * The signed/opaque state the framework gives the adapter to embed
   * in the URL. Passed back to the framework on the callback for
   * verification — adapters never inspect it.
   */
  state: string;
  /** OAuth scopes to request. Provider-specific values. */
  scopes: readonly string[];
  /**
   * Provider-specific extras the cross-provider surface doesn't
   * model (`access_type: "offline"`, `prompt: "consent"`, Microsoft
   * `tenant`, …). Adapters may consult this freely.
   */
  providerOptions?: Record<string, unknown>;
  /**
   * PKCE code-challenge — the SHA-256 hash of the framework-generated
   * code-verifier, base64url-encoded. When supplied, the adapter
   * emits `code_challenge` + `code_challenge_method` on the
   * authorization URL.
   *
   * The framework's routes layer generates the verifier, computes
   * the challenge, signs the verifier into state, and passes the
   * challenge here. Adapters never see the verifier on this call.
   * The verifier comes back later via `exchangeCodeForTokens`'s
   * `opts.codeVerifier`.
   *
   * Server-side flows are confidential clients, so PKCE is
   * defense-in-depth — defends against the (rare) case where the
   * authorization code is intercepted but the client_secret isn't.
   * OAuth 2.1 makes PKCE mandatory; the framework's posture matches.
   */
  codeChallenge?: string;
  /** PKCE challenge method. Default `"S256"`; only S256 is recommended. */
  codeChallengeMethod?: "S256" | "plain";
}

/**
 * Per-call options for `exchangeCodeForTokens` / `refreshTokens`.
 * `codeVerifier` is the PKCE counterpart to `AuthUrlOptions.codeChallenge` —
 * the framework's routes layer recovers it from the signed state on
 * callback and passes it here.
 */
export interface ExchangeCodeOptions {
  /** Abort the upstream HTTP call. */
  signal?: AbortSignal;
  /**
   * PKCE verifier (the raw secret the framework generated alongside
   * the challenge). Passed verbatim into the provider's token-
   * exchange body as `code_verifier`. Adapters that don't support
   * PKCE (or providers that ignore the field) simply forward it.
   */
  codeVerifier?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Computed expiry instant — adapters convert provider `expires_in` seconds. */
  expiresAt?: Date;
  scope?: string;
  /** Typically `"Bearer"`; some providers omit. */
  tokenType?: string;
  /**
   * Provider-specific extras (e.g. Google `id_token`, Microsoft
   * `tenant_id`, full SDK response object) that don't fit the
   * cross-provider columns. The schema's `metadata` jsonb column
   * stores this verbatim.
   */
  metadata?: Record<string, unknown>;
}

export interface OAuthAdapter {
  /** Stable provider identifier. Matches the `providerCode` column. */
  readonly providerCode: string;

  /**
   * Build the provider's authorization URL. Pure / synchronous —
   * adapter callers (the routes layer) do `Response.redirect(url)`
   * themselves.
   */
  buildAuthorizationUrl(credentials: OAuthClientCredentials, opts: AuthUrlOptions): string;

  /** Exchange the authorization code for an initial token pair. */
  exchangeCodeForTokens(
    code: string,
    credentials: OAuthClientCredentials,
    opts?: ExchangeCodeOptions,
  ): Promise<TokenResponse>;

  /** Use the refresh token to mint a new access token. */
  refreshTokens(
    refreshToken: string,
    credentials: OAuthClientCredentials,
    opts?: { signal?: AbortSignal },
  ): Promise<TokenResponse>;

  /**
   * Resolve the upstream provider's stable subject identifier from a
   * `TokenResponse`. Used to populate `provider_account_id` on the
   * connection row — lets a re-auth match an existing row instead of
   * creating a duplicate when the provider changes the access token
   * but keeps the same user.
   */
  getProviderAccountId(
    tokens: TokenResponse,
    credentials: OAuthClientCredentials,
    opts?: { signal?: AbortSignal },
  ): Promise<string>;

  /**
   * Optional revoke-access endpoint call. Best-effort; routes layer
   * still nulls the local row even if upstream revoke fails.
   */
  revokeAccess?(
    accessToken: string,
    credentials: OAuthClientCredentials,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
}

// ─── Errors ───────────────────────────────────────────────────────────

export class OAuthAdapterError extends Error {
  constructor(
    public readonly providerCode: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthAdapterError";
  }
}

export class TokenExchangeError extends OAuthAdapterError {
  constructor(providerCode: string, message: string) {
    super(providerCode, message);
    this.name = "TokenExchangeError";
  }
}

export class TokenRefreshError extends OAuthAdapterError {
  constructor(providerCode: string, message: string) {
    super(providerCode, message);
    this.name = "TokenRefreshError";
  }
}

export class InvalidCredentialsError extends OAuthAdapterError {
  constructor(providerCode: string, message: string) {
    super(providerCode, message);
    this.name = "InvalidCredentialsError";
  }
}

export class OAuthRateLimitError extends OAuthAdapterError {
  constructor(
    providerCode: string,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(providerCode, message);
    this.name = "OAuthRateLimitError";
  }
}
