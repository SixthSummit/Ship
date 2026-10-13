import { describe, expect, it } from "vitest";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthVerifyResult,
} from "../../app/auth/AuthProvider.js";
import { authenticateWsUpgrade, extractWsAuth } from "./auth.js";

interface TestAccount extends AuthenticatedAccount {
  id: string;
  email?: string;
}

interface FakeProviderConfig {
  verify?: () => Promise<AuthVerifyResult> | AuthVerifyResult;
  resolve?: () => Promise<TestAccount | null> | TestAccount | null;
  onUnknownAccount?: "reject" | "create" | "next";
}

function fakeProvider(cfg: FakeProviderConfig = {}): AuthProvider<TestAccount> {
  return {
    name: "fake",
    onUnknownAccount: cfg.onUnknownAccount,
    async verify() {
      return (cfg.verify ?? (async () => ({ ok: false, reason: "missing-token" })))();
    },
    async resolve() {
      return (cfg.resolve ?? (async () => null))();
    },
  };
}

describe("extractWsAuth", () => {
  it("returns empty defaults for an absent header", () => {
    expect(extractWsAuth(undefined)).toEqual({
      protocols: [],
      bearerToken: null,
      selectedSubprotocol: null,
    });
  });

  it("parses the canonical client form: ['ship-api.v1', 'bearer.<token>']", () => {
    const r = extractWsAuth("ship-api.v1, bearer.tok-abc");
    expect(r.protocols).toEqual(["ship-api.v1", "bearer.tok-abc"]);
    expect(r.bearerToken).toBe("tok-abc");
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
  });

  it("ignores leading/trailing whitespace per protocol", () => {
    const r = extractWsAuth("  ship-api.v1  ,   bearer.X  ");
    expect(r.bearerToken).toBe("X");
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
  });

  it("supports header-as-array (Node-style multi-value)", () => {
    const r = extractWsAuth(["ship-api.v1", "bearer.tok"]);
    expect(r.bearerToken).toBe("tok");
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
  });

  it("uses the FIRST bearer subprotocol when multiple are present", () => {
    const r = extractWsAuth("ship-api.v1, bearer.first, bearer.second");
    expect(r.bearerToken).toBe("first");
  });

  it("treats `bearer.` matching case-insensitively", () => {
    const r = extractWsAuth("ship-api.v1, BEARER.TOK");
    expect(r.bearerToken).toBe("TOK");
  });

  // F21: defensive case-handling regression tests. The case-insensitive
  // prefix check + case-sensitive slice is safe because every case
  // variant of `bearer.` is ASCII-length-equivalent. These tests pin
  // that invariant so a future prefix change that breaks it surfaces
  // here, not as a misaligned token at runtime.
  it("`Bearer.<token>` (TitleCase) extracts the token verbatim", () => {
    const r = extractWsAuth("ship-api.v1, Bearer.tok-Title-Case");
    expect(r.bearerToken).toBe("tok-Title-Case");
  });

  it("`BeArEr.<token>` (mixed case) extracts the token verbatim", () => {
    const r = extractWsAuth("ship-api.v1, BeArEr.tok-MiXeD");
    expect(r.bearerToken).toBe("tok-MiXeD");
  });

  it("token case is preserved through the slice (regression: no toLowerCase)", () => {
    const r = extractWsAuth("bearer.AbCdEf123_-");
    expect(r.bearerToken).toBe("AbCdEf123_-");
  });

  it("returns null bearerToken when no bearer subprotocol is present", () => {
    const r = extractWsAuth("ship-api.v1");
    expect(r.bearerToken).toBeNull();
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
  });

  it("returns null selectedSubprotocol when only a bearer is present", () => {
    const r = extractWsAuth("bearer.tok");
    expect(r.selectedSubprotocol).toBeNull();
    expect(r.bearerToken).toBe("tok");
  });
});

describe("authenticateWsUpgrade — happy path", () => {
  it("resolves Account on valid bearer + echoes the selected subprotocol", async () => {
    const account: TestAccount = { id: "a-1", email: "alice@example.com" };
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-1" } }),
      resolve: async () => account,
    });

    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1, bearer.tok" },
      provider,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.account).toEqual(account);
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
    expect(r.claims?.subject).toBe("u-1");
  });
});

describe("authenticateWsUpgrade — missing token", () => {
  it("rejects 401 by default when no bearer subprotocol is present", async () => {
    const provider = fakeProvider();
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1" },
      provider,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/bearer/i);
  });

  it("admits anonymous when optional: true (no bearer)", async () => {
    const provider = fakeProvider();
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1" },
      provider,
      optional: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.account).toBeNull();
    expect(r.selectedSubprotocol).toBe("ship-api.v1");
  });
});

describe("authenticateWsUpgrade — present-but-bad token", () => {
  it("rejects 401 even when optional: true (invalid tokens always reject)", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: false, reason: "expired-token", message: "expired" }),
    });
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1, bearer.expired" },
      provider,
      optional: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(401);
    expect(r.reason).toMatch(/expired/);
  });

  it.each([
    "invalid-token",
    "expired-token",
    "revoked-token",
    "issuer-mismatch",
    "provider-error",
  ] as const)("classifies %s as 401", async (reason) => {
    const provider = fakeProvider({ verify: async () => ({ ok: false, reason }) });
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1, bearer.x" },
      provider,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(401);
  });
});

describe("authenticateWsUpgrade — unknown account", () => {
  it("rejects 403 by default when verify ok but resolve returns null", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-x" } }),
      resolve: async () => null,
    });
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1, bearer.tok" },
      provider,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(403);
  });

  it("admits with claims when provider's onUnknownAccount: 'next'", async () => {
    const claims: AuthClaims = { subject: "u-x" };
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims }),
      resolve: async () => null,
      onUnknownAccount: "next",
    });
    const r = await authenticateWsUpgrade({
      headers: { "sec-websocket-protocol": "ship-api.v1, bearer.tok" },
      provider,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.account).toBeNull();
    expect(r.claims).toEqual(claims);
  });
});

describe("authenticateWsUpgrade — header forwarding", () => {
  it("passes the full headers object through to provider.verify (so adapters can read aux headers)", async () => {
    let observedHeaders: unknown;
    const provider: AuthProvider<TestAccount> = {
      name: "obs",
      async verify(ctx) {
        observedHeaders = ctx.headers;
        return { ok: true, claims: { subject: "u" } };
      },
      async resolve() {
        return { id: "a" };
      },
    };

    await authenticateWsUpgrade({
      headers: {
        "sec-websocket-protocol": "ship-api.v1, bearer.tok",
        "x-tenant": "t-1",
      },
      provider,
    });

    expect((observedHeaders as Record<string, unknown>)["x-tenant"]).toBe("t-1");
  });
});
