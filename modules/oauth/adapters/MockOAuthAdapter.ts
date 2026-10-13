import type {
  AuthUrlOptions,
  ExchangeCodeOptions,
  OAuthAdapter,
  OAuthClientCredentials,
  TokenResponse,
} from "./OAuthAdapter.js";

/**
 * In-memory `OAuthAdapter` for tests + local development. Returns
 * deterministic responses, captures every call for assertions, and
 * lets tests preset the responses to simulate provider failures.
 *
 * Usage in route tests:
 *
 * ```ts
 * const adapter = new MockOAuthAdapter("mock-google");
 * adapter.setExchangeResponse({ accessToken: "tok", ... });
 * const registry = oauthAdapterRegistry(adapter);
 * defineOAuthRoutes(app, { service, provider, adapters: registry });
 * ```
 */
export class MockOAuthAdapter implements OAuthAdapter {
  readonly providerCode: string;

  /** Each call to `buildAuthorizationUrl` is captured here. */
  authUrlCalls: Array<{
    credentials: OAuthClientCredentials;
    opts: AuthUrlOptions;
  }> = [];
  exchangeCalls: Array<{
    code: string;
    credentials: OAuthClientCredentials;
    opts?: ExchangeCodeOptions;
  }> = [];
  refreshCalls: Array<{
    refreshToken: string;
    credentials: OAuthClientCredentials;
  }> = [];
  revokeCalls: Array<{
    accessToken: string;
    credentials: OAuthClientCredentials;
  }> = [];

  private exchangeResponse: TokenResponse = {
    accessToken: "mock-access",
    refreshToken: "mock-refresh",
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: "openid",
    tokenType: "Bearer",
    metadata: { source: "mock" },
  };

  private refreshResponse: TokenResponse = {
    accessToken: "mock-access-refreshed",
    refreshToken: "mock-refresh",
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: "openid",
    tokenType: "Bearer",
    metadata: { source: "mock-refresh" },
  };

  private providerAccountId = "mock-provider-account-1";

  /** Set in tests to make the next exchange/refresh throw. */
  private exchangeError: Error | undefined;
  private refreshError: Error | undefined;

  constructor(providerCode = "mock") {
    this.providerCode = providerCode;
  }

  buildAuthorizationUrl(credentials: OAuthClientCredentials, opts: AuthUrlOptions): string {
    this.authUrlCalls.push({ credentials, opts });
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: credentials.redirectUri,
      response_type: "code",
      scope: opts.scopes.join(" "),
      state: opts.state,
    });
    return `https://mock.example.test/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    code: string,
    credentials: OAuthClientCredentials,
    opts: ExchangeCodeOptions = {},
  ): Promise<TokenResponse> {
    this.exchangeCalls.push({ code, credentials, opts });
    if (this.exchangeError) throw this.exchangeError;
    return this.exchangeResponse;
  }

  async refreshTokens(
    refreshToken: string,
    credentials: OAuthClientCredentials,
  ): Promise<TokenResponse> {
    this.refreshCalls.push({ refreshToken, credentials });
    if (this.refreshError) throw this.refreshError;
    return this.refreshResponse;
  }

  async getProviderAccountId(): Promise<string> {
    return this.providerAccountId;
  }

  async revokeAccess(accessToken: string, credentials: OAuthClientCredentials): Promise<void> {
    this.revokeCalls.push({ accessToken, credentials });
  }

  // ─── Test-only setters ────────────────────────────────────────────

  setExchangeResponse(response: TokenResponse): this {
    this.exchangeResponse = response;
    return this;
  }

  setRefreshResponse(response: TokenResponse): this {
    this.refreshResponse = response;
    return this;
  }

  setProviderAccountId(id: string): this {
    this.providerAccountId = id;
    return this;
  }

  failNextExchange(err: Error): this {
    this.exchangeError = err;
    return this;
  }

  failNextRefresh(err: Error): this {
    this.refreshError = err;
    return this;
  }
}
