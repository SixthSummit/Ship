/**
 * v4 oauth module — end-to-end route integration test.
 *
 * Exercises the same chain as `me-reference.test.ts` and
 * `accounts/routes.test.ts` but covering the full OAuth flow:
 *
 *   list → authorize → callback (provider redirect) → disconnect
 *
 * Adapter calls are routed through `MockOAuthAdapter` so no real
 * provider HTTP is exercised; the AuthProvider is a fake mirroring
 * Firebase semantics; the DB is an in-memory shape compatible with
 * Drizzle.
 */

import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "@sixthsummit/ship-api/app/auth/AuthProvider";
import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import { routeRegistry } from "@sixthsummit/ship-api/app/registry/routes";
import { createApp } from "@sixthsummit/ship-api/http/app/createApp";
import { registerErrorHandlers } from "@sixthsummit/ship-api/http/app/errors";
import { httpLogger } from "@sixthsummit/ship-api/http/middleware/httpLogger";
import type { SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockOAuthAdapter } from "./adapters/MockOAuthAdapter.js";
import { oauthAdapterRegistry } from "./adapters/OAuthAdapterRegistry.js";
import { buildOAuthApp, defineOAuthRoutes } from "./routes.js";
import type { oauthConnections } from "./schema.js";
import { OAuthConnectionService } from "./services/OAuthConnectionService.js";
import { signState } from "./state.js";

const STATE_SECRET = "test-secret-very-long-and-random-do-not-use-in-prod";
const ALICE_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ALICE_UID = "uid-alice";

interface CallRecord {
  kind: "select" | "selectAggregate" | "insert" | "insert.onConflict" | "update" | "delete";
  whereExpr?: SQL;
  insertValues?: unknown;
  setValues?: unknown;
}

function makeFakeDb(rows: Record<string, unknown>[] = []) {
  const calls: CallRecord[] = [];
  const store = [...rows];

  function selectChain(record: CallRecord, isAggregate: boolean) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      offset() {
        return chain;
      },
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        const result = isAggregate ? [{ value: store.length }] : store;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  const db = {
    select(arg?: unknown) {
      const isAggregate = arg !== undefined;
      const record: CallRecord = {
        kind: isAggregate ? "selectAggregate" : "select",
      };
      calls.push(record);
      return { from: () => selectChain(record, isAggregate) };
    },
    insert() {
      return {
        values(v: unknown) {
          const record: CallRecord = { kind: "insert", insertValues: v };
          calls.push(record);
          const newRow = {
            id: "22222222-2222-4222-8222-222222222222",
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            ...(v as Record<string, unknown>),
          };
          return {
            onConflictDoUpdate(o: { target: unknown; set: unknown }) {
              record.kind = "insert.onConflict";
              const insertValues = v as Record<string, unknown>;
              const merged = { ...newRow, ...insertValues };
              const existing = store.find(
                (r) =>
                  r.accountId === insertValues.accountId &&
                  r.providerCode === insertValues.providerCode,
              );
              if (existing) {
                Object.assign(existing, o.set);
                return { returning: async () => [existing] };
              }
              store.push(merged);
              return { returning: async () => [merged] };
            },
            returning: async () => {
              store.push(newRow);
              return [newRow];
            },
          };
        },
      };
    },
    update() {
      return {
        set(v: unknown) {
          const record: CallRecord = { kind: "update", setValues: v };
          calls.push(record);
          return {
            where(expr: SQL) {
              record.whereExpr = expr;
              return {
                returning: async () => {
                  if (store.length === 0) return [];
                  const updated = {
                    ...store[0],
                    ...(v as Record<string, unknown>),
                  };
                  store[0] = updated;
                  return [updated];
                },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(expr: SQL) {
          const record: CallRecord = { kind: "delete", whereExpr: expr };
          calls.push(record);
          return { returning: async () => store };
        },
      };
    },
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => fn(db),
  };

  return {
    db: db as unknown as ShipDb<{ oauthConnections: typeof oauthConnections }>,
    calls,
    seed(extra: Record<string, unknown>) {
      store.push(extra);
    },
    rows: () => store,
  };
}

interface TestAccount extends AuthenticatedAccount {
  permissions: Set<string>;
}

function fakeAuthProvider(byUid: Map<string, TestAccount>): AuthProvider<TestAccount> {
  return {
    name: "fake-firebase",
    onMissingToken: "reject",
    async verify(ctx: AuthProviderContext): Promise<AuthVerifyResult> {
      const auth = ctx.headers.authorization;
      if (!auth)
        return {
          ok: false,
          reason: "missing-token",
          message: "no Authorization header",
        };
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if (token === "expired") return { ok: false, reason: "expired-token", message: "expired" };
      const account = byUid.get(token);
      if (!account) return { ok: true, claims: { subject: token } };
      return { ok: true, claims: { subject: token } };
    },
    async resolve(claims: AuthClaims): Promise<TestAccount | null> {
      return byUid.get(claims.subject) ?? null;
    },
  };
}

const credentials = {
  google: {
    clientId: "google-cid",
    clientSecret: "google-csecret",
    redirectUri: "https://app.example.test/oauth/google/callback",
  },
};

function buildHarness(opts: { rows?: Record<string, unknown>[] } = {}) {
  routeRegistry.clear();

  const fakeDb = makeFakeDb(opts.rows ?? []);
  const service = new OAuthConnectionService(fakeDb.db);

  const alice: TestAccount = {
    id: ALICE_ACCOUNT_ID,
    permissions: new Set([
      "oauth:connections:read-self",
      "oauth:connections:read-any",
      "oauth:connections:connect",
      "oauth:connections:disconnect",
      "oauth:connections:refresh",
    ]),
    hasPermission(slug) {
      return alice.permissions.has(slug);
    },
  };

  const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));

  const googleAdapter = new MockOAuthAdapter("google");
  const adapters = oauthAdapterRegistry(googleAdapter);

  const credentialsResolver = (code: string) => (code === "google" ? credentials.google : null);

  const app = createApp();
  registerErrorHandlers(app as unknown as Hono<never>);
  app.use("*", httpLogger());
  defineOAuthRoutes(app as unknown as Hono, {
    service,
    provider,
    adapters,
    credentials: credentialsResolver,
    stateSecret: STATE_SECRET,
  });

  return {
    app: app as unknown as Hono,
    fakeDb,
    service,
    googleAdapter,
    alice,
  };
}

describe("v4 oauth routes — end-to-end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("route registry capture", () => {
    it("registers all 4 routes with auth + permission metadata", () => {
      buildHarness();
      const expected = [
        ["GET", "/oauth", "oauth:connections:read-self"],
        ["POST", "/oauth/:providerCode/authorize", "oauth:connections:connect"],
        ["DELETE", "/oauth/:providerCode", "oauth:connections:disconnect"],
      ] as const;
      for (const [method, path, perm] of expected) {
        const entry = routeRegistry.find(method, path);
        expect(entry, `${method} ${path}`).toBeDefined();
        expect(entry!.auth.required, `${method} ${path} auth`).toBe(true);
        expect(entry!.permissions, `${method} ${path} perm`).toContain(perm);
      }
      // Callback is intentionally PUBLIC (provider redirects to it; no
      // Authorization header in that flow). State HMAC is the auth.
      const callback = routeRegistry.find("GET", "/oauth/:providerCode/callback");
      expect(callback).toBeDefined();
      expect(callback!.auth.required).toBe(false);
    });
  });

  describe("GET /oauth (list)", () => {
    it("401 without Authorization", async () => {
      const { app } = buildHarness();
      const res = await app.request("/oauth");
      expect(res.status).toBe(401);
    });

    it("returns the user's connections — strips access/refresh tokens from the body", async () => {
      const { app } = buildHarness({
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            accountId: ALICE_ACCOUNT_ID,
            providerCode: "google",
            accessToken: "secret-access",
            refreshToken: "secret-refresh",
            expiresAt: new Date("2025-06-01T01:00:00Z"),
            scope: "openid email",
            tokenType: "Bearer",
            providerAccountId: "g-12345",
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
            createdBy: null,
            updatedBy: null,
          },
        ],
      });
      const res = await app.request("/oauth", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0].providerCode).toBe("google");
      expect(body[0].providerAccountId).toBe("g-12345");
      expect(body[0]).not.toHaveProperty("accessToken");
      expect(body[0]).not.toHaveProperty("refreshToken");
      expect(body[0].isActive).toBe(true);
    });
  });

  describe("POST /oauth/:providerCode/authorize", () => {
    it("returns the adapter-built authorize URL with signed state", async () => {
      const { app, googleAdapter } = buildHarness();
      const res = await app.request("/oauth/google/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scopes: ["openid", "email"],
          returnTo: "/settings",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; state: string };
      expect(body.state).toContain(".");
      expect(body.url).toMatch(/^https:\/\/mock\.example\.test\/authorize/);

      // Adapter saw the credentials + state.
      expect(googleAdapter.authUrlCalls).toHaveLength(1);
      expect(googleAdapter.authUrlCalls[0].opts.state).toBe(body.state);
      expect(googleAdapter.authUrlCalls[0].opts.scopes).toEqual(["openid", "email"]);
    });

    it("400 when the provider has no registered adapter", async () => {
      const { app } = buildHarness();
      const res = await app.request("/oauth/apple/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("400 when credentials resolver returns null", async () => {
      // Replace the credentials resolver with one that always returns null.
      routeRegistry.clear();
      const fakeDb = makeFakeDb();
      const service = new OAuthConnectionService(fakeDb.db);
      const alice: TestAccount = {
        id: ALICE_ACCOUNT_ID,
        permissions: new Set(["oauth:connections:connect"]),
        hasPermission: (s) => alice.permissions.has(s),
      };
      const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));
      const adapters = oauthAdapterRegistry(new MockOAuthAdapter("google"));
      const app = createApp();
      registerErrorHandlers(app as unknown as Hono<never>);
      app.use("*", httpLogger());
      defineOAuthRoutes(app as unknown as Hono, {
        service,
        provider,
        adapters,
        credentials: () => null,
        stateSecret: STATE_SECRET,
      });
      const res = await (app as unknown as Hono).request("/oauth/google/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("403 without the connect permission", async () => {
      const { app, alice } = buildHarness();
      alice.permissions = new Set([]);
      const res = await app.request("/oauth/google/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(res.status).toBe(403);
    });

    describe("returnTo open-redirect defenses (F1)", () => {
      const authHeaders = {
        authorization: `Bearer ${ALICE_UID}`,
        "content-type": "application/json",
      };

      async function authorize(
        app: Hono,
        returnTo: string | undefined,
        opts?: { allowlist?: readonly string[] },
      ) {
        return app.request("/oauth/google/authorize", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ scopes: [], returnTo }),
        });
      }

      it("accepts a same-origin relative path", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "/dashboard");
        expect(res.status).toBe(200);
      });

      it("accepts root /", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "/");
        expect(res.status).toBe(200);
      });

      it("rejects absolute https URL with no allowlist", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "https://attacker.example.com");
        expect(res.status).toBe(400);
      });

      it("rejects protocol-relative // URL", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "//attacker.example.com");
        expect(res.status).toBe(400);
      });

      it("rejects javascript: scheme", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "javascript:alert(1)");
        expect(res.status).toBe(400);
      });

      it("rejects data: scheme", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "data:text/html,<script>1</script>");
        expect(res.status).toBe(400);
      });

      it("rejects vbscript: scheme", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "vbscript:msgbox(1)");
        expect(res.status).toBe(400);
      });

      it("rejects file: scheme", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "file:///etc/passwd");
        expect(res.status).toBe(400);
      });

      it("rejects backslash host-confusion (/\\\\evil.com)", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "/\\evil.example.com");
        expect(res.status).toBe(400);
      });

      it("rejects CRLF / null byte in returnTo (header injection)", async () => {
        const { app } = buildHarness();
        const res = await authorize(app, "/dashboard\r\nLocation: https://attacker.com");
        expect(res.status).toBe(400);
      });

      it("accepts an absolute URL whose origin is in the allowlist", async () => {
        routeRegistry.clear();
        const fakeDb = makeFakeDb();
        const service = new OAuthConnectionService(fakeDb.db);
        const alice: TestAccount = {
          id: ALICE_ACCOUNT_ID,
          permissions: new Set(["oauth:connections:connect"]),
          hasPermission: (s) => alice.permissions.has(s),
        };
        const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));
        const adapters = oauthAdapterRegistry(new MockOAuthAdapter("google"));
        const app = createApp();
        registerErrorHandlers(app as unknown as Hono<never>);
        app.use("*", httpLogger());
        defineOAuthRoutes(app as unknown as Hono, {
          service,
          provider,
          adapters,
          credentials: (c: string) => (c === "google" ? credentials.google : null),
          stateSecret: STATE_SECRET,
          returnToAllowlist: ["https://app.example.com"],
        });
        const res = await (app as unknown as Hono).request("/oauth/google/authorize", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            scopes: [],
            returnTo: "https://app.example.com/post-auth",
          }),
        });
        expect(res.status).toBe(200);
      });

      it("rejects an absolute URL whose origin is NOT in the allowlist", async () => {
        routeRegistry.clear();
        const fakeDb = makeFakeDb();
        const service = new OAuthConnectionService(fakeDb.db);
        const alice: TestAccount = {
          id: ALICE_ACCOUNT_ID,
          permissions: new Set(["oauth:connections:connect"]),
          hasPermission: (s) => alice.permissions.has(s),
        };
        const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));
        const adapters = oauthAdapterRegistry(new MockOAuthAdapter("google"));
        const app = createApp();
        registerErrorHandlers(app as unknown as Hono<never>);
        app.use("*", httpLogger());
        defineOAuthRoutes(app as unknown as Hono, {
          service,
          provider,
          adapters,
          credentials: (c: string) => (c === "google" ? credentials.google : null),
          stateSecret: STATE_SECRET,
          returnToAllowlist: ["https://app.example.com"],
        });
        const res = await (app as unknown as Hono).request("/oauth/google/authorize", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            scopes: [],
            returnTo: "https://attacker.example.com/post-auth",
          }),
        });
        expect(res.status).toBe(400);
      });
    });
  });

  describe("callback returnTo defense-in-depth (F1)", () => {
    it("400 when state carries a returnTo that is no longer allowlisted", async () => {
      // Adopter signs a state under an old (permissive) configuration, then
      // tightens the allowlist mid-session. Callback must fail closed.
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "x",
        tokenType: "Bearer",
      });
      // No `returnToAllowlist` on the harness → absolute URLs are forbidden.
      const state = signState(
        {
          accountId: ALICE_ACCOUNT_ID,
          providerCode: "google",
          returnTo: "https://attacker.example.com/steal",
        },
        STATE_SECRET,
      );
      const res = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(400);
    });

    it("redirects to a relative returnTo recovered from state", async () => {
      // Regression for the existing happy path.
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "x",
        tokenType: "Bearer",
      });
      const state = signState(
        {
          accountId: ALICE_ACCOUNT_ID,
          providerCode: "google",
          returnTo: "/safe-target",
        },
        STATE_SECRET,
      );
      const res = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/safe-target");
    });
  });

  describe("GET /oauth/:providerCode/callback", () => {
    it("verifies state, exchanges the code, upserts the connection, redirects to returnTo", async () => {
      const { app, fakeDb, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "exchanged-access",
        refreshToken: "exchanged-refresh",
        expiresAt: new Date("2025-06-01T01:00:00Z"),
        scope: "openid email",
        tokenType: "Bearer",
        metadata: { id_token: "xxx" },
      });
      googleAdapter.setProviderAccountId("g-bound-1");

      const state = signState(
        {
          accountId: ALICE_ACCOUNT_ID,
          providerCode: "google",
          returnTo: "/dashboard",
        },
        STATE_SECRET,
      );

      const res = await app.request(
        `/oauth/google/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/dashboard");

      // Adapter saw the code + credentials.
      expect(googleAdapter.exchangeCalls).toHaveLength(1);
      expect(googleAdapter.exchangeCalls[0].code).toBe("auth-code-123");

      // Upsert hit the conflict path on the unique composite.
      const upsert = fakeDb.calls.find((c) => c.kind === "insert.onConflict");
      expect(upsert).toBeDefined();
      const inserted = upsert!.insertValues as Record<string, unknown>;
      expect(inserted.accountId).toBe(ALICE_ACCOUNT_ID);
      expect(inserted.providerCode).toBe("google");
      expect(inserted.accessToken).toBe("exchanged-access");
      expect(inserted.providerAccountId).toBe("g-bound-1");
      expect(inserted.metadata).toEqual({ id_token: "xxx" });
    });

    it("uses defaultRedirectUrl when state has no returnTo", async () => {
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "x",
        tokenType: "Bearer",
      });
      const state = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "google" },
        STATE_SECRET,
      );
      const res = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    });

    it("400 when state is missing", async () => {
      const { app } = buildHarness();
      const res = await app.request("/oauth/google/callback?code=abc");
      expect(res.status).toBe(400);
    });

    it("400 when code is missing", async () => {
      const { app } = buildHarness();
      const state = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "google" },
        STATE_SECRET,
      );
      const res = await app.request(`/oauth/google/callback?state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(400);
    });

    it("400 when state's signature is invalid", async () => {
      const { app } = buildHarness();
      const goodState = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "google" },
        STATE_SECRET,
      );
      const tampered = goodState.slice(0, -2) + "AA";
      const res = await app.request(
        `/oauth/google/callback?code=abc&state=${encodeURIComponent(tampered)}`,
      );
      expect(res.status).toBe(400);
    });

    it("400 when state's providerCode doesn't match the URL provider (cross-binding attack)", async () => {
      const { app } = buildHarness();
      const stateForMicrosoft = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "microsoft" },
        STATE_SECRET,
      );
      const res = await app.request(
        `/oauth/google/callback?code=abc&state=${encodeURIComponent(stateForMicrosoft)}`,
      );
      expect(res.status).toBe(400);
    });

    it("truncates pathologically long provider error strings to 256 chars (F23)", async () => {
      const { app } = buildHarness();
      const longErr = "x".repeat(2000);
      const longDesc = "y".repeat(2000);
      const res = await app.request(
        `/oauth/google/callback?error=${longErr}&error_description=${longDesc}`,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      // URL-encoded `x` = `x`, so a 256-char run is what's emitted.
      const match = location.match(/oauth_error=([^&]+)/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBe(256);
      const match2 = location.match(/oauth_error_description=([^&]+)/);
      expect(match2![1].length).toBe(256);
    });

    it("redirects with oauth_error params when provider returns an error", async () => {
      const { app } = buildHarness();
      const res = await app.request(
        "/oauth/google/callback?error=access_denied&error_description=User+declined",
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("oauth_error=access_denied");
      expect(location).toContain("oauth_error_description=User");
    });

    it("does NOT require an Authorization header (provider does the redirect)", async () => {
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "x",
        tokenType: "Bearer",
      });
      const state = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "google" },
        STATE_SECRET,
      );
      const res = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
        // No `authorization` header — must still work.
      );
      expect(res.status).toBe(302);
    });
  });

  describe("DELETE /oauth/:providerCode (disconnect)", () => {
    it("clears tokens + (best-effort) calls adapter.revokeAccess", async () => {
      const existingConn = {
        id: "44444444-4444-4444-8444-444444444444",
        accountId: ALICE_ACCOUNT_ID,
        providerCode: "google",
        accessToken: "tok",
        refreshToken: "rfk",
        expiresAt: new Date("2025-06-01T01:00:00Z"),
        scope: "openid",
        tokenType: "Bearer",
        providerAccountId: "g-1",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
      };
      const { app, fakeDb, googleAdapter } = buildHarness({
        rows: [existingConn],
      });

      const res = await app.request("/oauth/google", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(204);

      // Local clear ran.
      const update = fakeDb.calls.find((c) => c.kind === "update");
      expect(update).toBeDefined();
      const set = update!.setValues as Record<string, unknown>;
      expect(set.accessToken).toBeNull();
      expect(set.refreshToken).toBeNull();

      // Best-effort upstream revoke ran.
      expect(googleAdapter.revokeCalls).toHaveLength(1);
      expect(googleAdapter.revokeCalls[0].accessToken).toBe("tok");
    });

    it("404 when no connection for the provider exists", async () => {
      const { app } = buildHarness();
      const res = await app.request("/oauth/google", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(404);
    });

    it("still clears local tokens even when upstream revoke throws (revoke is best-effort)", async () => {
      const existingConn = {
        id: "55555555-5555-4555-8555-555555555555",
        accountId: ALICE_ACCOUNT_ID,
        providerCode: "google",
        accessToken: "tok",
        refreshToken: "rfk",
        expiresAt: new Date("2025-06-01T01:00:00Z"),
        scope: "openid",
        tokenType: "Bearer",
        providerAccountId: "g-1",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
      };
      const { app, fakeDb, googleAdapter } = buildHarness({
        rows: [existingConn],
      });

      // Adapter throws on revoke; route should swallow and continue.
      googleAdapter.revokeAccess = async () => {
        throw new Error("upstream 500");
      };

      const res = await app.request("/oauth/google", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(204);

      const update = fakeDb.calls.find((c) => c.kind === "update");
      expect(update).toBeDefined();
    });
  });

  describe("PKCE round-trip (F12)", () => {
    it("authorize URL carries code_challenge + S256; callback exchange receives the matching verifier", async () => {
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "exchanged",
        tokenType: "Bearer",
      });

      // 1) Authorize — capture the URL the adapter built + the state.
      const authRes = await app.request("/oauth/google/authorize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scopes: ["openid"] }),
      });
      expect(authRes.status).toBe(200);
      const { state } = (await authRes.json()) as { url: string; state: string };

      const authCall = googleAdapter.authUrlCalls[0];
      expect(authCall.opts.codeChallenge).toBeDefined();
      expect(authCall.opts.codeChallengeMethod).toBe("S256");
      const challenge = authCall.opts.codeChallenge!;
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url

      // 2) Callback — adapter.exchangeCodeForTokens should receive the
      // matching verifier from the signed state.
      const res = await app.request(
        `/oauth/google/callback?code=cb-code&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);

      expect(googleAdapter.exchangeCalls).toHaveLength(1);
      const exchange = googleAdapter.exchangeCalls[0];
      expect(exchange.opts?.codeVerifier).toBeDefined();
      expect(exchange.opts?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);

      // SHA-256(verifier) base64url-encoded must equal the challenge.
      const { createHash } = await import("node:crypto");
      const computedChallenge = createHash("sha256")
        .update(exchange.opts!.codeVerifier!)
        .digest("base64url");
      expect(computedChallenge).toBe(challenge);
    });

    it("rejects a second use of the same state within the JTI cache TTL (F16 replay defense)", async () => {
      const { app, googleAdapter } = buildHarness();
      googleAdapter.setExchangeResponse({
        accessToken: "x",
        tokenType: "Bearer",
      });
      const state = signState(
        { accountId: ALICE_ACCOUNT_ID, providerCode: "google" },
        STATE_SECRET,
      );
      const first = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(first.status).toBe(302);

      const second = await app.request(
        `/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(second.status).toBe(400);
      const body = (await second.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/already used/i);
    });

    it("each authorize call generates a fresh verifier (no reuse across requests)", async () => {
      const { app, googleAdapter } = buildHarness();
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) {
        await app.request("/oauth/google/authorize", {
          method: "POST",
          headers: {
            authorization: `Bearer ${ALICE_UID}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scopes: ["openid"] }),
        });
        const challenge = googleAdapter.authUrlCalls[i].opts.codeChallenge!;
        expect(seen.has(challenge)).toBe(false);
        seen.add(challenge);
      }
    });
  });
});

describe("buildOAuthApp — mount-at-root composition", () => {
  function mount() {
    routeRegistry.clear();
    const service = new OAuthConnectionService(makeFakeDb([]).db);
    const alice: TestAccount = {
      id: ALICE_ACCOUNT_ID,
      permissions: new Set(["oauth:connections:read-self"]),
      hasPermission(slug) {
        return alice.permissions.has(slug);
      },
    };
    const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));
    const adapters = oauthAdapterRegistry(new MockOAuthAdapter("google"));
    const oauthApp = buildOAuthApp({
      service,
      provider,
      adapters,
      credentials: (code: string) => (code === "google" ? credentials.google : null),
      stateSecret: STATE_SECRET,
    });
    const root = createApp();
    registerErrorHandlers(root as unknown as Hono<never>);
    root.use("*", httpLogger());
    root.route("/", oauthApp as unknown as Hono);
    return root as unknown as Hono;
  }

  it("dispatches a mounted oauth route through the root chain", async () => {
    const app = mount();
    const res = await app.request("/oauth", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(res.status).toBe(200);
  });

  it("tags oauth routes — including the public callback — with the `oauth` module", () => {
    mount();
    expect(routeRegistry.find("GET", "/oauth")?.module).toBe("oauth");
    expect(routeRegistry.find("GET", "/oauth/:providerCode/callback")?.module).toBe("oauth");
    expect(routeRegistry.find("POST", "/oauth/:providerCode/authorize")?.module).toBe("oauth");
  });
});
