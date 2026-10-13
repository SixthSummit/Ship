import type {
  AuthUrlOptions,
  ExchangeCodeOptions,
  OAuthAdapter,
  OAuthClientCredentials,
  TokenResponse,
} from "./OAuthAdapter.js";
import {
  InvalidCredentialsError,
  OAuthRateLimitError,
  TokenExchangeError,
  TokenRefreshError,
} from "./OAuthAdapter.js";

/**
 * Google OAuth 2.0 adapter — fetch-based, no SDK dependency.
 *
 * Implements the framework's `OAuthAdapter` interface against
 * Google's OAuth 2.0 endpoints directly:
 *   - Authorization:  https://accounts.google.com/o/oauth2/v2/auth
 *   - Token exchange: https://oauth2.googleapis.com/token
 *   - User info:      https://openidconnect.googleapis.com/v1/userinfo
 *   - Revoke:         https://oauth2.googleapis.com/revoke
 *
 * Replaces v3's `googleapis`-SDK-backed adapter. Fetch-based means
 * the adapter works in every runtime (Node, Workers, Bun) without
 * a 5+ MB SDK in the bundle. Consumers who want the full Google
 * SDK ergonomics for non-OAuth API calls (Gmail / Drive / Calendar
 * etc.) install `googleapis` separately.
 *
 * Provider-specific defaults the framework's contract doesn't
 * model:
 *   - `access_type: "offline"` — required to receive a refresh
 *     token. Set via `providerOptions` if you want the v3 default
 *     behavior.
 *   - `prompt: "consent"` — forces re-consent so a fresh refresh
 *     token is reissued even when the user has already granted
 *     access. Useful for "reconnect" flows.
 *   - `include_granted_scopes: true` — incremental authorization
 *     across multiple Google scopes.
 *
 * Default authorize URL adds `access_type=offline&prompt=consent`
 * automatically — that's the v3 behavior and the most common
 * Google flow. Override via `opts.providerOptions` per-call:
 *   ```ts
 *   adapter.buildAuthorizationUrl(creds, {
 *     state, scopes,
 *     providerOptions: { prompt: "select_account" },
 *   });
 *   ```
 */

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleOAuthAdapterOptions {
  /** Stable provider identifier. Default `"google"`. */
  providerCode?: string;
  /** Override `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Default `access_type`. Default `"offline"` (returns a refresh token). */
  defaultAccessType?: "online" | "offline";
  /** Default `prompt`. Default `"consent"` (forces fresh refresh token). */
  defaultPrompt?: "none" | "consent" | "select_account";
}

export class GoogleOAuthAdapter implements OAuthAdapter {
  readonly providerCode: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultAccessType: "online" | "offline";
  private readonly defaultPrompt: "none" | "consent" | "select_account";

  constructor(opts: GoogleOAuthAdapterOptions = {}) {
    this.providerCode = opts.providerCode ?? "google";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.defaultAccessType = opts.defaultAccessType ?? "offline";
    this.defaultPrompt = opts.defaultPrompt ?? "consent";
  }

  buildAuthorizationUrl(credentials: OAuthClientCredentials, opts: AuthUrlOptions): string {
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      response_type: "code",
      scope: opts.scopes.join(" "),
      state: opts.state,
      access_type: this.defaultAccessType,
      prompt: this.defaultPrompt,
      include_granted_scopes: "true",
    });

    // PKCE: emit challenge params when supplied. Adapters that don't
    // receive a challenge (consumers running against the old contract)
    // still produce a valid URL — the params are simply omitted.
    if (opts.codeChallenge) {
      params.set("code_challenge", opts.codeChallenge);
      params.set("code_challenge_method", opts.codeChallengeMethod ?? "S256");
    }

    // Provider-specific overrides win.
    if (opts.providerOptions) {
      for (const [key, val] of Object.entries(opts.providerOptions)) {
        params.set(key, String(val));
      }
    }

    return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthClientCredentials,
    opts: ExchangeCodeOptions = {},
  ): Promise<TokenResponse> {
    const formBody = new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      grant_type: "authorization_code",
    });
    if (opts.codeVerifier) formBody.set("code_verifier", opts.codeVerifier);

    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      signal: opts.signal,
    });

    if (!response.ok) {
      throw this.translateError(response, "exchange");
    }

    const body = (await response.json()) as GoogleTokenResponse;
    return tokenResponseFromGoogle(body);
  }

  async refreshTokens(
    refreshToken: string,
    credentials: OAuthClientCredentials,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TokenResponse> {
    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "refresh_token",
      }).toString(),
      signal: opts.signal,
    });

    if (!response.ok) {
      throw this.translateError(response, "refresh");
    }

    const body = (await response.json()) as GoogleTokenResponse;
    // Refresh responses don't always include a fresh refresh_token —
    // when omitted, Google expects callers to keep using the
    // existing one. Pass through what they sent (typically just
    // the new access_token + expires_in).
    return {
      ...tokenResponseFromGoogle(body),
      // Preserve the original refresh token when Google doesn't
      // rotate (most refresh responses don't).
      refreshToken: body.refresh_token ?? refreshToken,
    };
  }

  async getProviderAccountId(
    tokens: TokenResponse,
    _credentials: OAuthClientCredentials,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    void _credentials;
    if (!tokens.accessToken) {
      throw new TokenExchangeError(
        this.providerCode,
        "cannot resolve provider account id without an access token",
      );
    }
    const response = await this.fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      signal: opts.signal,
    });
    if (!response.ok) {
      throw this.translateError(response, "userinfo");
    }
    const body = (await response.json()) as GoogleUserInfo;
    if (!body.sub) {
      throw new TokenExchangeError(this.providerCode, "userinfo response missing `sub` claim");
    }
    return body.sub;
  }

  async revokeAccess(
    accessToken: string,
    _credentials: OAuthClientCredentials,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    void _credentials;
    // Google's revoke endpoint accepts the token via querystring.
    // Failures are best-effort; the routes layer doesn't abort the
    // local clear when revoke throws (per OAuthAdapter contract).
    await this.fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      signal: opts.signal,
    });
  }

  private translateError(
    response: Response,
    operation: "exchange" | "refresh" | "userinfo",
  ): Error {
    if (response.status === 401) {
      return new InvalidCredentialsError(
        this.providerCode,
        `Google ${operation}: invalid credentials (401)`,
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      return new OAuthRateLimitError(
        this.providerCode,
        `Google ${operation}: rate limit (429)`,
        retryAfter ? Number.parseInt(retryAfter, 10) : undefined,
      );
    }
    if (operation === "exchange") {
      return new TokenExchangeError(
        this.providerCode,
        `Google ${operation}: ${response.status} ${response.statusText}`,
      );
    }
    return new TokenRefreshError(
      this.providerCode,
      `Google ${operation}: ${response.status} ${response.statusText}`,
    );
  }
}

// ─── Internal types ────────────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function tokenResponseFromGoogle(body: GoogleTokenResponse): TokenResponse {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      body.expires_in !== undefined ? new Date(Date.now() + body.expires_in * 1000) : undefined,
    scope: body.scope,
    tokenType: body.token_type,
    metadata: {
      ...(body.id_token ? { id_token: body.id_token } : {}),
    },
  };
}
