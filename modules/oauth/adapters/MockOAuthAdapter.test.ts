import { describe, expect, it } from "vitest";
import { MockOAuthAdapter } from "./MockOAuthAdapter.js";

const credentials = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "https://app.example.test/oauth/callback",
};

describe("MockOAuthAdapter", () => {
  it("buildAuthorizationUrl encodes credentials + scopes + state into a URL", () => {
    const adapter = new MockOAuthAdapter("test-google");
    const url = adapter.buildAuthorizationUrl(credentials, {
      state: "opaque-state-token",
      scopes: ["openid", "profile", "email"],
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe("mock.example.test");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("redirect_uri")).toBe(credentials.redirectUri);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("openid profile email");
    expect(parsed.searchParams.get("state")).toBe("opaque-state-token");
  });

  it("captures every authorize call", () => {
    const adapter = new MockOAuthAdapter();
    adapter.buildAuthorizationUrl(credentials, {
      state: "s",
      scopes: ["a"],
    });
    expect(adapter.authUrlCalls).toHaveLength(1);
    expect(adapter.authUrlCalls[0].opts.state).toBe("s");
  });

  it("exchangeCodeForTokens returns the configured response by default", async () => {
    const adapter = new MockOAuthAdapter();
    const resp = await adapter.exchangeCodeForTokens("auth-code", credentials);
    expect(resp.accessToken).toBe("mock-access");
    expect(resp.refreshToken).toBe("mock-refresh");
    expect(resp.tokenType).toBe("Bearer");
    expect(resp.metadata).toEqual({ source: "mock" });
    expect(adapter.exchangeCalls).toHaveLength(1);
    expect(adapter.exchangeCalls[0].code).toBe("auth-code");
  });

  it("setExchangeResponse overrides what exchange returns", async () => {
    const customExpiry = new Date("2030-01-01T00:00:00Z");
    const adapter = new MockOAuthAdapter().setExchangeResponse({
      accessToken: "different",
      refreshToken: "different-refresh",
      expiresAt: customExpiry,
      scope: "different scope",
      tokenType: "Bearer",
    });
    const resp = await adapter.exchangeCodeForTokens("c", credentials);
    expect(resp.accessToken).toBe("different");
    expect(resp.expiresAt).toBe(customExpiry);
  });

  it("failNextExchange forces the next call to throw", async () => {
    const adapter = new MockOAuthAdapter().failNextExchange(new Error("provider unavailable"));
    await expect(adapter.exchangeCodeForTokens("c", credentials)).rejects.toThrowError(
      /provider unavailable/,
    );
  });

  it("refreshTokens returns the configured refresh response", async () => {
    const adapter = new MockOAuthAdapter();
    const resp = await adapter.refreshTokens("rfk", credentials);
    expect(resp.accessToken).toBe("mock-access-refreshed");
    expect(adapter.refreshCalls[0].refreshToken).toBe("rfk");
  });

  it("getProviderAccountId returns the configured value", async () => {
    const adapter = new MockOAuthAdapter().setProviderAccountId("user-abc-123");
    expect(await adapter.getProviderAccountId()).toBe("user-abc-123");
  });

  it("revokeAccess captures the call", async () => {
    const adapter = new MockOAuthAdapter();
    await adapter.revokeAccess("tok", credentials);
    expect(adapter.revokeCalls).toHaveLength(1);
    expect(adapter.revokeCalls[0].accessToken).toBe("tok");
  });
});
