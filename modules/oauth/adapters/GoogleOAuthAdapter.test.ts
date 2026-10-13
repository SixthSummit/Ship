import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleOAuthAdapter } from "./GoogleOAuthAdapter.js";
import {
  InvalidCredentialsError,
  OAuthRateLimitError,
  TokenExchangeError,
  TokenRefreshError,
} from "./OAuthAdapter.js";

const credentials = {
  clientId: "google-cid",
  clientSecret: "google-csecret",
  redirectUri: "https://app.example.test/oauth/google/callback",
};

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Build a fetch stub that returns queued responses. Records each
 * call for later assertion.
 */
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

describe("GoogleOAuthAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("construction", () => {
    it("defaults the providerCode to 'google'", () => {
      const adapter = new GoogleOAuthAdapter();
      expect(adapter.providerCode).toBe("google");
    });

    it("respects an explicit providerCode (e.g., for variants like gmail)", () => {
      const adapter = new GoogleOAuthAdapter({ providerCode: "gmail" });
      expect(adapter.providerCode).toBe("gmail");
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("builds a Google authorize URL with the documented defaults", () => {
      const adapter = new GoogleOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "opaque-state",
        scopes: ["openid", "profile", "email"],
      });
      const parsed = new URL(url);
      expect(parsed.host).toBe("accounts.google.com");
      expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
      expect(parsed.searchParams.get("client_id")).toBe("google-cid");
      expect(parsed.searchParams.get("redirect_uri")).toBe(credentials.redirectUri);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("scope")).toBe("openid profile email");
      expect(parsed.searchParams.get("state")).toBe("opaque-state");
      // Google-specific defaults — refresh-token-friendly.
      expect(parsed.searchParams.get("access_type")).toBe("offline");
      expect(parsed.searchParams.get("prompt")).toBe("consent");
      expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
    });

    it("respects providerOptions overrides", () => {
      const adapter = new GoogleOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
        providerOptions: { prompt: "select_account", login_hint: "alice@example.test" },
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("prompt")).toBe("select_account");
      expect(parsed.searchParams.get("login_hint")).toBe("alice@example.test");
    });

    it("constructor defaults flow through to the URL when no overrides", () => {
      const adapter = new GoogleOAuthAdapter({
        defaultAccessType: "online",
        defaultPrompt: "none",
      });
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("access_type")).toBe("online");
      expect(parsed.searchParams.get("prompt")).toBe("none");
    });
  });

  describe("buildAuthorizationUrl — PKCE (F12)", () => {
    it("appends code_challenge + code_challenge_method when supplied", () => {
      const adapter = new GoogleOAuthAdapter();
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
      const adapter = new GoogleOAuthAdapter();
      const url = adapter.buildAuthorizationUrl(credentials, {
        state: "s",
        scopes: ["openid"],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has("code_challenge")).toBe(false);
      expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("POSTs to the token endpoint with the documented body shape", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          json: {
            access_token: "ya29.access",
            refresh_token: "1//refresh",
            expires_in: 3600,
            scope: "openid profile email",
            token_type: "Bearer",
            id_token: "header.payload.sig",
          },
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      const tokens = await adapter.exchangeCodeForTokens("auth-code", credentials);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
      expect(calls[0].init.method).toBe("POST");
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("client_id")).toBe("google-cid");
      expect(body.get("client_secret")).toBe("google-csecret");
      expect(body.get("redirect_uri")).toBe(credentials.redirectUri);
      expect(body.get("grant_type")).toBe("authorization_code");

      // Translation surface
      expect(tokens.accessToken).toBe("ya29.access");
      expect(tokens.refreshToken).toBe("1//refresh");
      expect(tokens.tokenType).toBe("Bearer");
      expect(tokens.scope).toBe("openid profile email");
      expect(tokens.expiresAt?.getTime()).toBe(Date.now() + 3600 * 1000);
      expect(tokens.metadata).toEqual({ id_token: "header.payload.sig" });
    });

    it("throws InvalidCredentialsError on 401", async () => {
      const { fetchImpl } = stubFetch([
        { status: 401, statusText: "Unauthorized", json: { error: "invalid_client" } },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await expect(adapter.exchangeCodeForTokens("c", credentials)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    });

    it("throws OAuthRateLimitError on 429 with retryAfter parsed", async () => {
      const { fetchImpl } = stubFetch([
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "60" },
          json: {},
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      try {
        await adapter.exchangeCodeForTokens("c", credentials);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthRateLimitError);
        expect((err as OAuthRateLimitError).retryAfterSeconds).toBe(60);
      }
    });

    it("throws TokenExchangeError on generic error responses", async () => {
      const { fetchImpl } = stubFetch([
        { status: 500, statusText: "Internal Server Error", json: {} },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await expect(adapter.exchangeCodeForTokens("c", credentials)).rejects.toBeInstanceOf(
        TokenExchangeError,
      );
    });

    it("includes code_verifier in the body when supplied (PKCE) — F12", async () => {
      const { fetchImpl, calls } = stubFetch([
        { json: { access_token: "ya29", expires_in: 3600 } },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await adapter.exchangeCodeForTokens("auth-code", credentials, {
        codeVerifier: "verifier-xyz-43-chars-base64url-safe-AAAAAA",
      });
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code_verifier")).toBe("verifier-xyz-43-chars-base64url-safe-AAAAAA");
    });

    it("omits code_verifier from the body when not supplied (back-compat)", async () => {
      const { fetchImpl, calls } = stubFetch([{ json: { access_token: "ya29" } }]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await adapter.exchangeCodeForTokens("auth-code", credentials);
      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("code_verifier")).toBeNull();
    });
  });

  describe("refreshTokens", () => {
    it("POSTs to the token endpoint with grant_type=refresh_token", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          json: {
            access_token: "new-access",
            expires_in: 3600,
            scope: "openid",
            token_type: "Bearer",
          },
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await adapter.refreshTokens("rfk-original", credentials);

      const body = new URLSearchParams(calls[0].init.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rfk-original");
      expect(body.get("client_id")).toBe("google-cid");
      expect(body.get("client_secret")).toBe("google-csecret");
    });

    it("preserves the original refresh token when Google omits one in the response", async () => {
      const { fetchImpl } = stubFetch([
        {
          json: {
            access_token: "new-access",
            expires_in: 3600,
            scope: "openid",
            token_type: "Bearer",
            // refresh_token deliberately omitted
          },
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      const tokens = await adapter.refreshTokens("rfk-original", credentials);
      expect(tokens.accessToken).toBe("new-access");
      expect(tokens.refreshToken).toBe("rfk-original");
    });

    it("uses the new refresh token when Google rotates", async () => {
      const { fetchImpl } = stubFetch([
        {
          json: {
            access_token: "new-access",
            refresh_token: "rfk-rotated",
            expires_in: 3600,
          },
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      const tokens = await adapter.refreshTokens("rfk-original", credentials);
      expect(tokens.refreshToken).toBe("rfk-rotated");
    });

    it("throws TokenRefreshError on non-401 errors", async () => {
      const { fetchImpl } = stubFetch([
        { status: 400, statusText: "Bad Request", json: { error: "invalid_grant" } },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await expect(adapter.refreshTokens("rfk", credentials)).rejects.toBeInstanceOf(
        TokenRefreshError,
      );
    });
  });

  describe("getProviderAccountId", () => {
    it("calls the OIDC userinfo endpoint with the access token", async () => {
      const { fetchImpl, calls } = stubFetch([
        {
          json: {
            sub: "112233445566778899",
            email: "alice@example.test",
            name: "Alice",
          },
        },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      const id = await adapter.getProviderAccountId({ accessToken: "ya29.access" }, credentials);
      expect(id).toBe("112233445566778899");
      expect(calls[0].url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
        "Bearer ya29.access",
      );
    });

    it("throws when the response omits `sub`", async () => {
      const { fetchImpl } = stubFetch([{ json: {} }]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await expect(
        adapter.getProviderAccountId({ accessToken: "tok" }, credentials),
      ).rejects.toThrow(/sub/i);
    });

    it("throws when no access token is present", async () => {
      const adapter = new GoogleOAuthAdapter();
      await expect(adapter.getProviderAccountId({ accessToken: "" }, credentials)).rejects.toThrow(
        /access token/i,
      );
    });
  });

  describe("revokeAccess", () => {
    it("calls the revoke endpoint with the token in the querystring", async () => {
      const { fetchImpl, calls } = stubFetch([{ status: 200, text: "" }]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await adapter.revokeAccess("ya29.access", credentials);
      expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke?token=ya29.access");
      expect(calls[0].init.method).toBe("POST");
    });

    it("is best-effort — does not throw on upstream failure", async () => {
      const { fetchImpl } = stubFetch([
        { status: 500, statusText: "Internal Server Error", text: "boom" },
      ]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      await expect(adapter.revokeAccess("tok", credentials)).resolves.toBeUndefined();
    });
  });

  describe("AbortSignal", () => {
    it("forwards signal to fetch on token exchange", async () => {
      const { fetchImpl, calls } = stubFetch([{ json: { access_token: "x", expires_in: 60 } }]);
      const adapter = new GoogleOAuthAdapter({ fetchImpl });
      const ac = new AbortController();
      await adapter.exchangeCodeForTokens("c", credentials, { signal: ac.signal });
      expect(calls[0].init.signal).toBe(ac.signal);
    });
  });
});
