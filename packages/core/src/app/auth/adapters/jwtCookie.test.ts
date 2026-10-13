import { Hono } from "hono";
import { generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthenticationError } from "../../../http/errors/AuthenticationError.js";
import { AuthorizationError } from "../../../http/errors/AuthorizationError.js";
import { requireAuth } from "../../../http/middleware/requireAuth.js";
import { AUTH_COOKIE_NAMES, setAuthCookies } from "../../../http/utils/authCookies.js";
import { AuthFlow } from "../jwt/AuthFlow.js";
import { JwtSigner } from "../jwt/JwtSigner.js";
import { InMemoryRefreshTokenStore } from "../jwt/RefreshTokenStore.js";
import { jwtCookieAuth } from "./jwtCookie.js";

interface TestAccount {
  id: string;
  hasPermission?: (slug: string) => boolean;
}

let publicKey: CryptoKey;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
});

function buildHarness(
  opts: {
    findAccount?: (id: string) => Promise<TestAccount | null>;
    onMissingToken?: "reject" | "next";
    onUnknownAccount?: "reject" | "create" | "next";
    /**
     * Override the JwtSigner's clock tolerance. Framework default is
     * 30s; tests that assert tight-window expiration set this to 0 so
     * a sub-second wait actually crosses the rejection boundary.
     */
    clockToleranceSec?: number;
  } = {},
) {
  const signer = new JwtSigner({
    signingKey: { kid: "k1", privateKey },
    verificationKeys: [{ kid: "k1", publicKey }],
    clockToleranceSec: opts.clockToleranceSec,
  });
  const store = new InMemoryRefreshTokenStore();
  const flow = new AuthFlow({ signer, refreshTokenStore: store });
  const findAccount = opts.findAccount ?? (async (id: string) => ({ id }) as TestAccount);
  const provider = jwtCookieAuth<TestAccount>({
    signer,
    findAccount,
    onMissingToken: opts.onMissingToken,
    onUnknownAccount: opts.onUnknownAccount,
  });
  return { signer, store, flow, provider };
}

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AuthenticationError) {
      return c.json({ code: err.code, message: err.message }, 401);
    }
    if (err instanceof AuthorizationError) {
      return c.json({ code: err.code, message: err.message }, 403);
    }
    return c.json({ message: "internal" }, 500);
  });
  return app;
}

async function loginAndGetCookieHeader(flow: AuthFlow, accountId: string): Promise<string> {
  // Use the flow to issue a real pair, then format the access cookie value.
  const pair = await flow.issue({ accountId });
  return `${AUTH_COOKIE_NAMES.access}=${pair.accessToken}`;
}

describe("jwtCookieAuth — adapter properties", () => {
  it("declares its name and default policies", () => {
    const { provider } = buildHarness();
    expect(provider.name).toBe("jwt-cookie");
    expect(provider.onMissingToken).toBe("reject");
    expect(provider.onUnknownAccount).toBe("reject");
  });

  it("propagates onMissingToken / onUnknownAccount overrides", () => {
    const { provider } = buildHarness({
      onMissingToken: "next",
      onUnknownAccount: "next",
    });
    expect(provider.onMissingToken).toBe("next");
    expect(provider.onUnknownAccount).toBe("next");
  });
});

describe("jwtCookieAuth + requireAuth — end-to-end", () => {
  it("reads the access cookie, verifies, resolves the account, and sets c.get('user')", async () => {
    const { provider, flow } = buildHarness({
      findAccount: async (id) => ({ id, hasPermission: () => true }),
    });
    const app = makeApp();
    app.get("/me", requireAuth({ provider }), (c) => {
      const user = c.get("user") as TestAccount;
      return c.json({ id: user.id });
    });

    const cookie = await loginAndGetCookieHeader(flow, "acct-77");
    const res = await app.request("/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("acct-77");
  });

  it("issues 401 when no access cookie is present (default reject policy)", async () => {
    const { provider } = buildHarness();
    const app = makeApp();
    app.get("/me", requireAuth({ provider }), (c) => c.text("ok"));

    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });

  it("falls through (next) on missing cookie when requireAuth({ optional: true })", async () => {
    const { provider } = buildHarness();
    const app = makeApp();
    app.get("/maybe-me", requireAuth({ provider, optional: true }), (c) => {
      const user = c.get("user") as TestAccount | undefined;
      return c.json({ authenticated: Boolean(user) });
    });

    const res = await app.request("/maybe-me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
  });

  it("rejects a present-but-bad token even when optional=true", async () => {
    const { provider } = buildHarness();
    const app = makeApp();
    app.get("/maybe-me", requireAuth({ provider, optional: true }), (c) => c.text("ok"));
    const res = await app.request("/maybe-me", {
      headers: { cookie: `${AUTH_COOKIE_NAMES.access}=tampered.token.value` },
    });
    expect(res.status).toBe(401);
  });

  it("issues 403 when the JWT verifies but findAccount returns null", async () => {
    const { provider, flow } = buildHarness({
      findAccount: async () => null,
    });
    const app = makeApp();
    app.get("/me", requireAuth({ provider }), (c) => c.text("ok"));

    const cookie = await loginAndGetCookieHeader(flow, "acct-missing");
    const res = await app.request("/me", { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("falls through with claims-only when onUnknownAccount=next and no account is found", async () => {
    const { provider, flow } = buildHarness({
      findAccount: async () => null,
      onUnknownAccount: "next",
    });
    const app = makeApp();
    app.get("/profile", requireAuth({ provider }), (c) => {
      const user = c.get("user") as TestAccount | undefined;
      const claims = c.get("claims") as { subject?: string } | undefined;
      return c.json({
        hasUser: Boolean(user),
        subject: claims?.subject ?? null,
      });
    });

    const cookie = await loginAndGetCookieHeader(flow, "acct-orphan");
    const res = await app.request("/profile", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasUser: boolean; subject: string | null };
    expect(body.hasUser).toBe(false);
    expect(body.subject).toBe("acct-orphan");
  });

  it("propagates custom claims through claims.metadata.custom", async () => {
    const { signer, provider } = buildHarness();
    // Bypass AuthFlow to set custom claims directly.
    const signed = await signer.sign({
      subject: "acct-9",
      ttlSec: 60,
      claims: { tenant: "t-9", roles: ["admin"] },
    });
    const app = makeApp();
    app.get("/me", requireAuth({ provider }), (c) => {
      const claims = c.get("claims") as {
        metadata?: { custom?: Record<string, unknown> };
      };
      return c.json({ tenant: claims.metadata?.custom?.tenant });
    });
    const res = await app.request("/me", {
      headers: { cookie: `${AUTH_COOKIE_NAMES.access}=${signed.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant?: string };
    expect(body.tenant).toBe("t-9");
  });

  it("rejects an expired access cookie", async () => {
    // Strict-mode signer so the 1.1s wait below crosses the
    // rejection boundary — the framework default tolerance is 30s.
    const { signer, provider } = buildHarness({ clockToleranceSec: 0 });
    // Pre-sign with a 1-second TTL, then force time forward.
    const signed = await signer.sign({ subject: "acct-9", ttlSec: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    const app = makeApp();
    app.get("/me", requireAuth({ provider }), (c) => c.text("ok"));
    const res = await app.request("/me", {
      headers: { cookie: `${AUTH_COOKIE_NAMES.access}=${signed.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("reads cookies set by the framework's setAuthCookies helper", async () => {
    // End-to-end: an issuer endpoint logs the user in by writing the cookies,
    // a follower endpoint authenticates via those cookies. Mirrors the
    // /auth/login → /me flow consumers will build.
    const { provider, flow } = buildHarness();
    const app = makeApp();

    app.post("/auth/login", async (c) => {
      const pair = await flow.issue({ accountId: "acct-roundtrip" });
      setAuthCookies(c, pair, { secure: false });
      return c.json({ ok: true });
    });
    app.get("/me", requireAuth({ provider }), (c) => {
      const user = c.get("user") as TestAccount;
      return c.json({ id: user.id });
    });

    const loginRes = await app.request("/auth/login", { method: "POST" });
    expect(loginRes.status).toBe(200);

    // Pull the access cookie out of the Set-Cookie header and replay it.
    const setCookies = loginRes.headers.getSetCookie();
    const accessHeader = setCookies.find((h) => h.startsWith(AUTH_COOKIE_NAMES.access))!;
    const accessValue = accessHeader.split(";")[0]; // name=value
    const meRes = await app.request("/me", { headers: { cookie: accessValue } });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { id: string };
    expect(body.id).toBe("acct-roundtrip");
  });
});
