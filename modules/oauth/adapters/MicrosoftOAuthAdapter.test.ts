import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrosoftOAuthAdapter } from "./MicrosoftOAuthAdapter.js";
import {
  InvalidCredentialsError,
  OAuthRateLimitError,
  TokenExchangeError,
  TokenRefreshError,
} from "./OAuthAdapter.js";

const credentials = {
  clientId: "ms-cid",
  clientSecret: "ms-csecret",
  redirectUri: "https://app.example.test/oauth/microsoft/callback",
};

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  responses: Array<{
    status?: number;
    statusText?: string;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
  }>,
): { fetchImpl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      init: init ?? {},
    });
    const next = queue.shift();
    if (!next) throw new Error("stubFetch: no more responses queued");
    const headers = new Headers(next.headers ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", next.json !== undefined ? "application/json" : "text/plain");
    }
    const body = next.text ?? (next.json !== undefined ? JSON.stringify(next.json) : "");
    return new Response(body, {
      status: next.status ?? 200,
      statusText: next.statusText ?? "OK",
      headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("MicrosoftOAuthAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("construction", () => {
    it("defaults the providerCode to 'microsoft' and tenant to 'common'", () => {
      const adapter = new MicrosoftOAuthAdapter();
      expect(adapter.providerCode).toBe("microsoft");
    });

    it("accepts a single-tenant override", () => {
      const adapter = new MicrosoftOAuthAdapter({
        tenant: "contoso.onmicrosoft.com",
        providerCode: "outlook",
      });
      expect(adapter.providerCode).toBe("outlook");
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
      });
      expect(url).toContain("/contoso.onmicrosoft.com/");
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("builds a tenant-scoped authorize URL", () => {
      const adapter = new MicrosoftOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "opaque",
        scopes: ["openid", "profile", "email", "User.Read"],
      });
      const parsed = new URL(url);
      expect(parsed.host).toBe("login.microsoftonline.com");
      expect(parsed.pathname).toBe("/common/oauth2/v2.0/authorize");
      expect(parsed.searchParams.get("client_id")).toBe("ms-cid");
      expect(parsed.searchParams.get("redirect_uri")).toBe(credentials.redirectUri);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("scope")).toBe("openid profile email User.Read");
      expect(parsed.searchParams.get("state")).toBe("opaque");
      expect(parsed.searchParams.get("response_mode")).toBe("query");
    });

    it("respects per-call providerOptions.tenant override", () => {
      const adapter = new MicrosoftOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
        providerOptions: { tenant: "organizations" },
      });
      expect(new URL(url).pathname).toBe("/organizations/oauth2/v2.0/authorize");
    });

    it("passes through other providerOptions (excluding `tenant`)", () => {
      const adapter = new MicrosoftOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
        providerOptions: {
          tenant: "common",
          domain_hint: "contoso.com",
          login_hint: "alice@contoso.com",
        },
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("domain_hint")).toBe("contoso.com");
      expect(parsed.searchParams.get("login_hint")).toBe("alice@contoso.com");
      // tenant should not appear as a search param.
      expect(parsed.searchParams.get("tenant")).toBeNull();
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("POSTs to the tenant-scoped token endpoint with documented body shape", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          json: {
            token_type: "Bearer",
            scope: "openid profile email",
            expires_in: 3599,
            ext_expires_in: 3599,
            access_token: "eyJ.access",
            refresh_token: "0.AXY.refresh",
            id_token: "header.payload.sig",
          },
        },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      const tokens = await adapter.exchangeCodeForTokens("auth-code", credentials);

      expect(calls[0].url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      expect(calls[0].init.method).toBe("POST");
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("grant_type")).toBe("authorization_code");

      // Translation surface
      expect(tokens.accessToken).toBe("eyJ.access");
      expect(tokens.refreshToken).toBe("0.AXY.refresh");
      expect(tokens.tokenType).toBe("Bearer");
      expect(tokens.expiresAt?.getTime()).toBe(Date.now() + 3599 * 1000);
      expect(tokens.metadata).toEqual({
        id_token: "header.payload.sig",
        ext_expires_in: 3599,
      });
    });

    it("respects single-tenant URL when constructed with tenant override", async () => {
      const { fetchImpl, calls } = stubFetch([{ json: { access_token: "x", expires_in: 60 } }]);
      const adapter = new MicrosoftOAuthAdapter({
        fetchImpl,
        tenant: "contoso.onmicrosoft.com",
      });
      await adapter.exchangeCodeForTokens("c", credentials);
      expect(calls[0].url).toBe(
        "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
      );
    });

    it("throws InvalidCredentialsError on 401", async () => {
      const { fetchImpl } = stubFetch([{ status: 401, statusText: "Unauthorized", json: {} }]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await expect(adapter.exchangeCodeForTokens("c", credentials)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it("throws OAuthRateLimitError on 429 with retryAfter parsed", async () => {
      const { fetchImpl } = stubFetch([
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "30" },
          json: {},
        },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      try {
        await adapter.exchangeCodeForTokens("c", credentials);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthRateLimitError);
        expect((err as OAuthRateLimitError).retryAfterSeconds).toBe(30);
      }
    });

    it("throws TokenExchangeError on generic 5xx", async () => {
      const { fetchImpl } = stubFetch([
        { status: 503, statusText: "Service Unavailable", json: {} },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await expect(adapter.exchangeCodeForTokens("c", credentials)).rejects.toBeInstanceOf(
        TokenExchangeError,
      );
    });

    it("includes code_verifier in the body when supplied (PKCE) — F12", async () => {
      const { fetchImpl, calls } = stubFetch([
        { json: { access_token: "ms-access", expires_in: 3600 } },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await adapter.exchangeCodeForTokens("auth-code", credentials, {
        codeVerifier: "verifier-xyz-43-chars-base64url-safe-AAAAAA",
      });
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code_verifier")).toBe("verifier-xyz-43-chars-base64url-safe-AAAAAA");
    });

    it("omits code_verifier from the body when not supplied (back-compat)", async () => {
      const { fetchImpl, calls } = stubFetch([{ json: { access_token: "ms-access" } }]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await adapter.exchangeCodeForTokens("auth-code", credentials);
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code_verifier")).toBeNull();
    });
  });

  describe("buildAuthorizationUrl — PKCE (F12)", () => {
    it("appends code_challenge + code_challenge_method when supplied", () => {
      const adapter = new MicrosoftOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
        codeChallenge: "abc123",
        codeChallengeMethod: "S256",
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("code_challenge")).toBe("abc123");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("omits PKCE params when codeChallenge is not supplied (back-compat)", () => {
      const adapter = new MicrosoftOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has("code_challenge")).toBe(false);
      expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
    });
  });

  describe("refreshTokens", () => {
    it("uses the rotated refresh_token when Microsoft sends one", async () => {
      const { fetchImpl } = stubFetch([
        {
          json: {
            access_token: "new-access",
            refresh_token: "0.AXY.rotated",
            expires_in: 3599,
            token_type: "Bearer",
          },
        },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      const tokens = await adapter.refreshTokens("0.AXY.original", credentials);
      expect(tokens.accessToken).toBe("new-access");
      expect(tokens.refreshToken).toBe("0.AXY.rotated");
    });

    it("falls back to the original refresh token when Microsoft omits one", async () => {
      const { fetchImpl } = stubFetch([{ json: { access_token: "new-access", expires_in: 60 } }]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      const tokens = await adapter.refreshTokens("rfk-original", credentials);
      expect(tokens.refreshToken).toBe("rfk-original");
    });

    it("throws TokenRefreshError on non-401 errors", async () => {
      const { fetchImpl } = stubFetch([
        { status: 400, statusText: "Bad Request", json: { error: "invalid_grant" } },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await expect(adapter.refreshTokens("rfk", credentials)).rejects.toBeInstanceOf(
        TokenRefreshError,
      );
    });
  });

  describe("getProviderAccountId", () => {
    it("calls Graph /me with the access token and returns the `id` field", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          json: {
            id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
            userPrincipalName: "alice@contoso.com",
            displayName: "Alice",
          },
        },
      ]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      const id = await adapter.getProviderAccountId({ accessToken: "eyJ.access" }, credentials);
      expect(id).toBe("00000000-0000-0000-0000-aaaaaaaaaaaa");
      expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
        "Bearer eyJ.access",
      );
    });

    it("throws when the response omits `id`", async () => {
      const { fetchImpl } = stubFetch([{ json: { userPrincipalName: "alice@contoso.com" } }]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      await expect(
        adapter.getProviderAccountId({ accessToken: "tok" }, credentials),
      ).rejects.toThrow(/id/i);
    });

    it("throws when no access token is present", async () => {
      const adapter = new MicrosoftOAuthAdapter();
      await expect(adapter.getProviderAccountId({ accessToken: "" }, credentials)).rejects.toThrow(
        /access token/i,
      );
    });
  });

  describe("revokeAccess", () => {
    it("is a best-effort no-op (Microsoft has no standard revoke endpoint)", async () => {
      const adapter = new MicrosoftOAuthAdapter();
      // No fetch stub needed — should not call out.
      await expect(adapter.revokeAccess()).resolves.toBeUndefined();
    });
  });

  describe("AbortSignal", () => {
    it("forwards signal to fetch on token exchange", async () => {
      const { fetchImpl, calls } = stubFetch([{ json: { access_token: "x", expires_in: 60 } }]);
      const adapter = new MicrosoftOAuthAdapter({ fetchImpl });
      const ac = new AbortController();
      await adapter.exchangeCodeForTokens("c", credentials, { signal: ac.signal });
      expect(calls[0].init.signal).toBe(ac.signal);
    });
  });
});
