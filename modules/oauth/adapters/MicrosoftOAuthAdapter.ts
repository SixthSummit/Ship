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
 * Microsoft / Azure AD OAuth 2.0 adapter — fetch-based, no SDK.
 *
 * Implements the framework's `OAuthAdapter` interface against
 * Microsoft's v2.0 endpoints directly:
 *   - Authorization:  https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
 *   - Token exchange: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   - User info:      https://graph.microsoft.com/v1.0/me
 *   - Revoke: standard OAuth 2.0 has no Microsoft revoke endpoint.
 *     `revokeAccess` is a best-effort no-op (returns silently); the
 *     routes layer's local clear runs unconditionally per the
 *     `OAuthAdapter` contract.
 *
 * Tenant handling: defaults to `"common"` (multi-tenant apps —
 * accepts personal MS accounts + work accounts). Override via
 * `tenant` in the constructor for single-tenant deployments
 * (`new MicrosoftOAuthAdapter({ tenant: "contoso.onmicrosoft.com" })`)
 * or per-call via `opts.providerOptions.tenant` on `buildAuthorizationUrl`.
 *
 * Microsoft's `provider_account_id` resolves from the Graph `/me`
 * endpoint's `id` field — a stable directory object identifier
 * suitable for cross-session linkage. The `oid` claim from the
 * id_token is equivalent for token-only resolution paths.
 */

const AUTHORIZE_PATH = "/oauth2/v2.0/authorize";
const TOKEN_PATH = "/oauth2/v2.0/token";
const ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

export interface MicrosoftOAuthAdapterOptions {
  /** Stable provider identifier. Default `"microsoft"`. */
  providerCode?: string;
  /**
   * Microsoft tenant. Default `"common"` (multi-tenant). Use
   * `"organizations"` to restrict to work/school accounts,
   * `"consumers"` for personal MS accounts only, or a tenant ID /
   * domain for a single-tenant app.
   */
  tenant?: string;
  /** Override `fetch` (tests). */
  fetchImpl?: typeof fetch;
}

export class MicrosoftOAuthAdapter implements OAuthAdapter {
  readonly providerCode: string;
  private readonly tenant: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MicrosoftOAuthAdapterOptions = {}) {
    this.providerCode = opts.providerCode ?? "microsoft";
    this.tenant = opts.tenant ?? "common";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  buildAuthorizationUrl(credentials: OAuthClientCredentials, opts: AuthUrlOptions): string {
    const tenant = this.resolveTenant(opts.providerOptions);
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      response_type: "code",
      scope: opts.scopes.join(" "),
      state: opts.state,
      response_mode: "query",
    });

    // PKCE: emit challenge params when supplied (F12).
    if (opts.codeChallenge) {
      params.set("code_challenge", opts.codeChallenge);
      params.set("code_challenge_method", opts.codeChallengeMethod ?? "S256");
    }

    // Pass-through provider options excluding `tenant` (consumed above).
    if (opts.providerOptions) {
      for (const [key, val] of Object.entries(opts.providerOptions)) {
        if (key === "tenant") continue;
        params.set(key, String(val));
      }
    }

    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}${AUTHORIZE_PATH}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthClientCredentials,
    opts: ExchangeCodeOptions = {},
  ): Promise<TokenResponse> {
    const url = this.tokenUrl();
    const formBody = new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      grant_type: "authorization_code",
    });
    if (opts.codeVerifier) formBody.set("code_verifier", opts.codeVerifier);

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
      signal: opts.signal,
    });

    if (!response.ok) {
      throw this.translateError(response, "exchange");
    }

    const body = (await response.json()) as MicrosoftTokenResponse;
    return tokenResponseFromMicrosoft(body);
  }

  async refreshTokens(
    refreshToken: string,
    credentials: OAuthClientCredentials,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TokenResponse> {
    const url = this.tokenUrl();
    const response = await this.fetchImpl(url, {
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

    const body = (await response.json()) as MicrosoftTokenResponse;
    // Microsoft typically rotates refresh tokens on refresh; pass
    // through what they send. Fall back to the original on the
    // off-chance Microsoft omits it (consistent with Google's
    // behavior for the same edge case).
    return {
      ...tokenResponseFromMicrosoft(body),
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
    const response = await this.fetchImpl(ME_ENDPOINT, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      signal: opts.signal,
    });
    if (!response.ok) {
      throw this.translateError(response, "userinfo");
    }
    const body = (await response.json()) as MicrosoftMeResponse;
    if (!body.id) {
      throw new TokenExchangeError(this.providerCode, "Graph /me response missing `id` field");
    }
    return body.id;
  }

  // Microsoft has no token-revoke endpoint in OAuth 2.0. Best-effort
  // no-op per the OAuthAdapter contract; the routes layer's local
  // clear runs regardless.
  async revokeAccess(): Promise<void> {
    return;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private resolveTenant(providerOptions: AuthUrlOptions["providerOptions"]): string {
    const override = providerOptions?.tenant;
    if (typeof override === "string" && override.length > 0) return override;
    return this.tenant;
  }

  private tokenUrl(tenantOverride?: string): string {
    const tenant = tenantOverride ?? this.tenant;
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}${TOKEN_PATH}`;
  }

  private translateError(
    response: Response,
    operation: "exchange" | "refresh" | "userinfo",
  ): Error {
    if (response.status === 401) {
      return new InvalidCredentialsError(
        this.providerCode,
        `Microsoft ${operation}: invalid credentials (401)`,
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      return new OAuthRateLimitError(
        this.providerCode,
        `Microsoft ${operation}: rate limit (429)`,
        retryAfter ? Number.parseInt(retryAfter, 10) : undefined,
      );
    }
    if (operation === "exchange") {
      return new TokenExchangeError(
        this.providerCode,
        `Microsoft ${operation}: ${response.status} ${response.statusText}`,
      );
    }
    return new TokenRefreshError(
      this.providerCode,
      `Microsoft ${operation}: ${response.status} ${response.statusText}`,
    );
  }
}

// ─── Internal types ────────────────────────────────────────────────────

interface MicrosoftTokenResponse {
  token_type?: string;
  scope?: string;
  expires_in?: number;
  ext_expires_in?: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

interface MicrosoftMeResponse {
  id?: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
}

function tokenResponseFromMicrosoft(body: MicrosoftTokenResponse): TokenResponse {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      body.expires_in !== undefined ? new Date(Date.now() + body.expires_in * 1000) : undefined,
    scope: body.scope,
    tokenType: body.token_type,
    metadata: {
      ...(body.id_token ? { id_token: body.id_token } : {}),
      ...(body.ext_expires_in !== undefined ? { ext_expires_in: body.ext_expires_in } : {}),
    },
  };
}
