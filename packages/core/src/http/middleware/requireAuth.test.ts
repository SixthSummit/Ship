import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "../../app/auth/AuthProvider.js";
import { getRequestContext, runWithRequestContext } from "../../app/context/RequestContext.js";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { AuthorizationError } from "../errors/AuthorizationError.js";
import { AUTH_META, type AuthMeta, getMetaTag } from "../utils/metaTags.js";
import { requireAuth } from "./requireAuth.js";

interface TestAccount extends AuthenticatedAccount {
  email?: string;
  hasPermission?: (slug: string) => boolean;
}

interface FakeProviderConfig {
  verify?: (ctx: AuthProviderContext) => Promise<AuthVerifyResult> | AuthVerifyResult;
  resolve?: (claims: AuthClaims) => Promise<TestAccount | null> | TestAccount | null;
  name?: string;
  onMissingToken?: "reject" | "next";
  onUnknownAccount?: "reject" | "create" | "next";
}

function fakeProvider(cfg: FakeProviderConfig = {}): AuthProvider<TestAccount> {
  return {
    name: cfg.name ?? "fake",
    onMissingToken: cfg.onMissingToken,
    onUnknownAccount: cfg.onUnknownAccount,
    async verify(ctx) {
      return (cfg.verify ?? (async () => ({ ok: false, reason: "missing-token" })))(ctx);
    },
    async resolve(claims) {
      return (cfg.resolve ?? (async () => null))(claims);
    },
  };
}

function makeApp(handlers: Parameters<Hono["use"]>[0][] = []): Hono {
  const app = new Hono();
  // Register a global error handler so AppError throws produce JSON 401/403
  app.onError((err, c) => {
    if (err instanceof AuthenticationError) {
      return c.json({ code: err.code, message: err.message }, 401);
    }
    if (err instanceof AuthorizationError) {
      return c.json({ code: err.code, message: err.message }, 403);
    }
    return c.json({ message: "internal" }, 500);
  });
  for (const h of handlers) app.use("*", h);
  return app;
}

describe("requireAuth — happy path", () => {
  it("verifies, resolves, and sets user + claims on success", async () => {
    const account: TestAccount = { id: "a-1", email: "alice@example.com" };
    const provider = fakeProvider({
      verify: async () => ({
        ok: true,
        claims: { subject: "u-1", email: "alice@example.com" },
      }),
      resolve: async () => account,
    });

    const app = makeApp([requireAuth({ provider })]);
    let observedUser: unknown;
    let observedClaims: unknown;
    app.get("/me", (c) => {
      observedUser = c.get("user" as never);
      observedClaims = c.get("claims" as never);
      return c.json({ ok: true });
    });

    const res = await app.request("/me", { headers: { authorization: "Bearer abc" } });
    expect(res.status).toBe(200);
    expect(observedUser).toEqual(account);
    expect(observedClaims).toMatchObject({ subject: "u-1", email: "alice@example.com" });
  });
});

describe("requireAuth — RequestContext.userId stamping", () => {
  it("publishes the resolved account id to RequestContext.userId", async () => {
    const account: TestAccount = { id: "a-42", email: "z@y.com" };
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-1" } }),
      resolve: async () => account,
    });
    const app = makeApp();
    // Mirror httpLogger: establish a RequestContext before requireAuth runs.
    app.use("*", async (_c, next) => runWithRequestContext({}, () => next()));
    app.use("*", requireAuth({ provider }));
    let seen: string | undefined;
    app.get("/me", (c) => {
      seen = getRequestContext()?.userId;
      return c.json({ ok: true });
    });

    const res = await app.request("/me", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(seen).toBe("a-42");
  });

  it("does not throw when no RequestContext is active (best-effort stamping)", async () => {
    const account: TestAccount = { id: "a-7" };
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-1" } }),
      resolve: async () => account,
    });
    const app = makeApp([requireAuth({ provider })]);
    app.get("/me", (c) => c.json({ ok: true }));

    const res = await app.request("/me", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
  });
});

describe("requireAuth — missing token", () => {
  it("throws 401 by default when no credential is on the request", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: false, reason: "missing-token" }),
    });
    const app = makeApp([requireAuth({ provider })]);
    app.get("/me", (c) => c.text("never"));

    const res = await app.request("/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTHENTICATION_ERROR");
  });

  it("falls through to next() when optional: true", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: false, reason: "missing-token" }),
    });
    const app = makeApp([requireAuth({ provider, optional: true })]);
    let observedUser: unknown = "set-by-default";
    app.get("/me", (c) => {
      observedUser = c.get("user" as never);
      return c.json({ ok: true });
    });

    const res = await app.request("/me");
    expect(res.status).toBe(200);
    expect(observedUser).toBeUndefined();
  });
});

describe("requireAuth — present-but-bad token", () => {
  it("throws 401 even when optional: true (present token must be valid)", async () => {
    const provider = fakeProvider({
      verify: async () => ({
        ok: false,
        reason: "expired-token",
        message: "token expired",
      }),
    });
    const app = makeApp([requireAuth({ provider, optional: true })]);
    app.get("/me", (c) => c.text("never"));

    const res = await app.request("/me", { headers: { authorization: "Bearer expired" } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("token expired");
  });

  it.each([
    "invalid-token",
    "expired-token",
    "revoked-token",
    "issuer-mismatch",
    "provider-error",
  ] as const)("classifies %s reason as 401", async (reason) => {
    const provider = fakeProvider({
      verify: async () => ({ ok: false, reason, message: `bad: ${reason}` }),
    });
    const app = makeApp([requireAuth({ provider })]);
    app.get("/me", (c) => c.text("never"));

    const res = await app.request("/me", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(401);
  });
});

describe("requireAuth — unknown account", () => {
  it("throws 403 by default when verify ok but resolve returns null", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-x" } }),
      resolve: async () => null,
    });
    const app = makeApp([requireAuth({ provider })]);
    app.get("/me", (c) => c.text("never"));

    const res = await app.request("/me", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTHORIZATION_ERROR");
  });

  it("falls through with claims set when provider's onUnknownAccount: 'next'", async () => {
    const provider = fakeProvider({
      verify: async () => ({ ok: true, claims: { subject: "u-x", email: "x@y.com" } }),
      resolve: async () => null,
      onUnknownAccount: "next",
    });
    const app = makeApp([requireAuth({ provider })]);
    let observedClaims: unknown;
    let observedUser: unknown = "set-by-default";
    app.get("/me", (c) => {
      observedClaims = c.get("claims" as never);
      observedUser = c.get("user" as never);
      return c.json({ ok: true });
    });

    const res = await app.request("/me", { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    expect(observedClaims).toMatchObject({ subject: "u-x" });
    expect(observedUser).toBeUndefined();
  });
});

describe("requireAuth — provider context", () => {
  it("passes lower-cased headers to AuthProvider.verify", async () => {
    let receivedCtx: AuthProviderContext | undefined;
    const provider = fakeProvider({
      verify: async (ctx) => {
        receivedCtx = ctx;
        return { ok: true, claims: { subject: "u-1" } };
      },
      resolve: async () => ({ id: "a-1" }),
    });
    const app = makeApp([requireAuth({ provider })]);
    app.get("/me", (c) => c.json({}));

    await app.request("/me", {
      headers: {
        Authorization: "Bearer abc",
        "X-Custom-Provider": "firebase",
      },
    });

    expect(receivedCtx?.headers.authorization).toBe("Bearer abc");
    expect(receivedCtx?.headers["x-custom-provider"]).toBe("firebase");
  });
});

describe("requireAuth — metadata tag", () => {
  it("attaches AUTH_META with required=true and providerName", () => {
    const provider = fakeProvider({ name: "firebase" });
    const mw = requireAuth({ provider });
    const tag = getMetaTag<AuthMeta>(mw, AUTH_META);
    expect(tag).toEqual({ required: true, providerName: "firebase" });
  });

  it("attaches AUTH_META with required=false when optional: true", () => {
    const provider = fakeProvider({ name: "firebase" });
    const mw = requireAuth({ provider, optional: true });
    const tag = getMetaTag<AuthMeta>(mw, AUTH_META);
    expect(tag?.required).toBe(false);
  });
});
