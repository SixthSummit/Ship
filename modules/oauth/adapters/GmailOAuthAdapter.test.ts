import { describe, expect, it, vi } from "vitest";
import { GmailOAuthAdapter } from "./GmailOAuthAdapter.js";
import { GoogleOAuthAdapter } from "./GoogleOAuthAdapter.js";

const credentials = {
  clientId: "google-cid",
  clientSecret: "google-csecret",
  redirectUri: "https://app.example.test/oauth/gmail/callback",
};

function stubFetchOnce(json: unknown) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  return fetchImpl as unknown as typeof fetch;
}

describe("GmailOAuthAdapter", () => {
  it("pre-fills providerCode = 'gmail'", () => {
    const adapter = new GmailOAuthAdapter();
    expect(adapter.providerCode).toBe("gmail");
  });

  it("inherits from GoogleOAuthAdapter (instanceof both)", () => {
    const adapter = new GmailOAuthAdapter();
    expect(adapter).toBeInstanceOf(GmailOAuthAdapter);
    expect(adapter).toBeInstanceOf(GoogleOAuthAdapter);
  });

  it("authorize URL still hits accounts.google.com (provenance unchanged)", () => {
    const adapter = new GmailOAuthAdapter();
    const url = adapter.buildAuthorizationUrl(credentials, {
      state: "opaque",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe("accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    // Google-specific defaults still apply (offline + consent).
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("token-exchange flows through inherited code", async () => {
    const fetchImpl = stubFetchOnce({
      access_token: "ya29.gmail-access",
      refresh_token: "1//gmail-refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
    });
    const adapter = new GmailOAuthAdapter({ fetchImpl });
    const tokens = await adapter.exchangeCodeForTokens("auth-code", credentials);
    expect(tokens.accessToken).toBe("ya29.gmail-access");
    expect(tokens.refreshToken).toBe("1//gmail-refresh");
    expect(tokens.tokenType).toBe("Bearer");
  });

  it("forwards constructor options (defaultAccessType, defaultPrompt) to the parent", () => {
    const adapter = new GmailOAuthAdapter({
      defaultAccessType: "online",
      defaultPrompt: "select_account",
    });
    const url = adapter.buildAuthorizationUrl(credentials, {
      state: "s",
      scopes: ["openid"],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBe("online");
    expect(parsed.searchParams.get("prompt")).toBe("select_account");
  });
});
