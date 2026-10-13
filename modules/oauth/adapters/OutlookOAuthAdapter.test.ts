import { describe, expect, it, vi } from "vitest";
import { MicrosoftOAuthAdapter } from "./MicrosoftOAuthAdapter.js";
import { OutlookOAuthAdapter } from "./OutlookOAuthAdapter.js";

const credentials = {
  clientId: "ms-cid",
  clientSecret: "ms-csecret",
  redirectUri: "https://app.example.test/oauth/outlook/callback",
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

describe("OutlookOAuthAdapter", () => {
  it("pre-fills providerCode = 'outlook'", () => {
    const adapter = new OutlookOAuthAdapter();
    expect(adapter.providerCode).toBe("outlook");
  });

  it("inherits from MicrosoftOAuthAdapter (instanceof both)", () => {
    const adapter = new OutlookOAuthAdapter();
    expect(adapter).toBeInstanceOf(OutlookOAuthAdapter);
    expect(adapter).toBeInstanceOf(MicrosoftOAuthAdapter);
  });

  it("authorize URL still hits login.microsoftonline.com (provenance unchanged)", () => {
    const adapter = new OutlookOAuthAdapter();
    const url = adapter.buildAuthorizationUrl(credentials, {
      state: "opaque",
      scopes: ["https://graph.microsoft.com/Mail.Read"],
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe("login.microsoftonline.com");
    expect(parsed.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(parsed.searchParams.get("scope")).toBe("https://graph.microsoft.com/Mail.Read");
    expect(parsed.searchParams.get("response_mode")).toBe("query");
  });

  it("token-exchange flows through inherited code", async () => {
    const fetchImpl = stubFetchOnce({
      token_type: "Bearer",
      scope: "https://graph.microsoft.com/Mail.Read",
      expires_in: 3599,
      access_token: "eyJ.outlook-access",
      refresh_token: "0.AXY.outlook-refresh",
    });
    const adapter = new OutlookOAuthAdapter({ fetchImpl });
    const tokens = await adapter.exchangeCodeForTokens("auth-code", credentials);
    expect(tokens.accessToken).toBe("eyJ.outlook-access");
    expect(tokens.refreshToken).toBe("0.AXY.outlook-refresh");
    expect(tokens.tokenType).toBe("Bearer");
  });

  it("forwards constructor options (tenant) to the parent", () => {
    const adapter = new OutlookOAuthAdapter({
      tenant: "contoso.onmicrosoft.com",
    });
    const url = adapter.buildAuthorizationUrl(credentials, {
      state: "s",
      scopes: ["openid"],
    });
    expect(new URL(url).pathname).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
  });
});
