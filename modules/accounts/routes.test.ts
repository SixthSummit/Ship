/**
 * v4 accounts module — end-to-end route integration test.
 *
 * Exercises the same chain as `me-reference.test.ts` but across the full
 * account CRUD surface: httpLogger → requireAuth → requirePermission →
 * validate → handler → DrizzleEntityService. This is the contract the
 * accounts port pins down.
 *
 * Real-Postgres integration via testcontainers comes in a separate batch.
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
import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountsApp, defineAccountsRoutes } from "./routes.js";
import type { accounts } from "./schema.js";
import { AccountService } from "./services/AccountService.js";

// ─── Fake Drizzle DB ────────────────────────────────────────────────────

interface CallRecord {
  kind: "select" | "selectAggregate" | "insert" | "update" | "delete";
  whereExpr?: SQL;
  limit?: number;
  offset?: number;
  values?: unknown;
}

function makeFakeDb(initialRows: Record<string, unknown>[]) {
  const calls: CallRecord[] = [];
  const rows = [...initialRows];

  function makeSelectChain(record: CallRecord, isAggregate: boolean) {
    const chain = {
      where(expr: SQL) {
        record.whereExpr = expr;
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n: number) {
        record.limit = n;
        return chain;
      },
      offset(n: number) {
        record.offset = n;
        return chain;
      },
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        const result = isAggregate ? [{ value: rows.length }] : rows;
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
      return { from: () => makeSelectChain(record, isAggregate) };
    },
    insert() {
      return {
        values(v: unknown) {
          const record: CallRecord = { kind: "insert", values: v };
          calls.push(record);
          const created = {
            id: "00000000-0000-0000-0000-000000000001",
            ...(v as Record<string, unknown>),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          return {
            returning: async () => [created],
          };
        },
      };
    },
    update() {
      return {
        set(v: unknown) {
          const record: CallRecord = { kind: "update", values: v };
          calls.push(record);
          return {
            where(expr: SQL) {
              record.whereExpr = expr;
              return {
                returning: async () => {
                  if (rows.length === 0) return [];
                  return [{ ...rows[0], ...(v as Record<string, unknown>) }];
                },
              };
            },
          };
        },
      };
    },
    update_BUILDER: undefined,
    delete() {
      return {
        where(expr: SQL) {
          const record: CallRecord = { kind: "delete", whereExpr: expr };
          calls.push(record);
          return {
            returning: async () => (rows.length > 0 ? [rows[0]] : []),
          };
        },
      };
    },
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => fn(db),
  };

  return {
    db: db as unknown as ShipDb<{ accounts: typeof accounts }>,
    calls,
  };
}

// ─── Fake AuthProvider ──────────────────────────────────────────────────

interface TestAccount extends AuthenticatedAccount {
  email: string;
  displayName: string;
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
      return { ok: true, claims: { subject: token, email: account.email } };
    },
    async resolve(claims: AuthClaims): Promise<TestAccount | null> {
      return byUid.get(claims.subject) ?? null;
    },
  };
}

// ─── Test fixtures ──────────────────────────────────────────────────────

const aliceRow = {
  id: "a1b2c3d4-e5f6-4789-8abc-123456789abc",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  firebaseUid: "uid-alice",
  isActive: true,
  roleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
};

describe("v4 accounts module — end-to-end", () => {
  let alice: TestAccount;
  let provider: AuthProvider<TestAccount>;
  let service: AccountService;
  let dbCalls: CallRecord[];

  beforeEach(() => {
    routeRegistry.clear();

    alice = {
      id: aliceRow.id,
      email: aliceRow.email,
      displayName: aliceRow.displayName,
      permissions: new Set([
        "accounts:read",
        "accounts:create",
        "accounts:update",
        "accounts:delete",
      ]),
      hasPermission(slug: string) {
        return alice.permissions.has(slug);
      },
    };

    const fake = makeFakeDb([aliceRow]);
    dbCalls = fake.calls;
    service = new AccountService(fake.db);

    const byUid = new Map<string, TestAccount>([["uid-alice", alice]]);
    provider = fakeAuthProvider(byUid);
  });

  function build(): Hono {
    const app = createApp();
    registerErrorHandlers(app as unknown as Hono<never>);
    app.use("*", httpLogger());
    defineAccountsRoutes(app as unknown as Hono, { service, provider });
    return app as unknown as Hono;
  }

  describe("route registry capture", () => {
    it("registers all 7 account routes with auth + permission metadata", () => {
      build();
      const expected = [
        ["POST", "/accounts", "accounts:create"],
        ["GET", "/accounts", "accounts:read"],
        ["GET", "/accounts/list", "accounts:read"],
        ["GET", "/accounts/count", "accounts:read"],
        ["GET", "/accounts/:id", "accounts:read"],
        ["PUT", "/accounts/:id", "accounts:update"],
        ["DELETE", "/accounts/:id", "accounts:delete"],
      ] as const;
      for (const [method, path, perm] of expected) {
        const entry = routeRegistry.find(method, path);
        expect(entry, `${method} ${path}`).toBeDefined();
        expect(entry!.auth.required, `${method} ${path} auth`).toBe(true);
        expect(entry!.permissions, `${method} ${path} perm`).toContain(perm);
      }
    });

    it("captures the validate() schemas on POST /accounts (json) and GET /accounts (query)", () => {
      build();
      const post = routeRegistry.find("POST", "/accounts");
      expect(post?.schemas.json).toBeDefined();
      const get = routeRegistry.find("GET", "/accounts");
      expect(get?.schemas.query).toBeDefined();
    });
  });

  describe("authentication + authorization", () => {
    it("returns 401 when the request has no Authorization header", async () => {
      const app = build();
      const res = await app.request("/accounts");
      expect(res.status).toBe(401);
    });

    it("returns 401 with an explicitly bad token shape", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer expired" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when the resolved user lacks accounts:read", async () => {
      alice.permissions = new Set([]);
      const app = build();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("AUTHORIZATION_ERROR");
    });

    it("returns 403 on POST /accounts when accounts:create is missing", async () => {
      alice.permissions = new Set(["accounts:read"]);
      const app = build();
      const res = await app.request("/accounts", {
        method: "POST",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "new@example.com" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("validation", () => {
    it("rejects POST /accounts with missing required `email`", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        method: "POST",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects POST /accounts with extra unknown keys (strict schema)", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        method: "POST",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "x@example.com",
          unknownField: "boom",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects GET /accounts/:id with a non-uuid param", async () => {
      const app = build();
      const res = await app.request("/accounts/not-a-uuid", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects GET /accounts?perPage=999 (over the 100 cap)", async () => {
      const app = build();
      const res = await app.request("/accounts?perPage=999", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("happy paths", () => {
    it("GET /accounts returns the rows on a valid request", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].id).toBe(aliceRow.id);
    });

    it("GET /accounts/:id returns the row when found", async () => {
      const app = build();
      const res = await app.request(`/accounts/${aliceRow.id}`, {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; email: string };
      expect(body.id).toBe(aliceRow.id);
      expect(body.email).toBe(aliceRow.email);
    });

    it("GET /accounts/count returns { count }", async () => {
      const app = build();
      const res = await app.request("/accounts/count", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(1);
    });

    it("GET /accounts/list returns { rows, total, page, perPage }", async () => {
      const app = build();
      const res = await app.request("/accounts/list?page=1&perPage=20", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: unknown[];
        total: number;
        page: number;
        perPage: number;
      };
      expect(body.page).toBe(1);
      expect(body.perPage).toBe(20);
    });

    it("POST /accounts creates and returns 201", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        method: "POST",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "new@example.com",
          displayName: "New User",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { email: string };
      expect(body.email).toBe("new@example.com");
      expect(dbCalls.some((c) => c.kind === "insert")).toBe(true);
    });

    it("PUT /accounts/:id updates and returns 200", async () => {
      const app = build();
      const res = await app.request(`/accounts/${aliceRow.id}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({ displayName: "Alice Smith" }),
      });
      expect(res.status).toBe(200);
      expect(dbCalls.some((c) => c.kind === "update")).toBe(true);
    });

    it("DELETE /accounts/:id soft-deletes and returns 204", async () => {
      const app = build();
      const res = await app.request(`/accounts/${aliceRow.id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });
  });

  describe("not-found", () => {
    it("GET /accounts/:id returns 404 with NOT_FOUND code when row is missing", async () => {
      const fake = makeFakeDb([]);
      service = new AccountService(fake.db);
      const app = build();
      const res = await app.request("/accounts/22222222-2222-4222-8222-222222222222", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND_ERROR");
    });

    it("PUT /accounts/:id returns 404 when row is missing", async () => {
      const fake = makeFakeDb([]);
      service = new AccountService(fake.db);
      const app = build();
      const res = await app.request("/accounts/22222222-2222-4222-8222-222222222222", {
        method: "PUT",
        headers: {
          authorization: "Bearer uid-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({ displayName: "ghost" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /accounts/:id returns 404 when row is missing", async () => {
      const fake = makeFakeDb([]);
      service = new AccountService(fake.db);
      const app = build();
      const res = await app.request("/accounts/22222222-2222-4222-8222-222222222222", {
        method: "DELETE",
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("request id propagation", () => {
    it("echoes the X-Request-Id header through the chain", async () => {
      const app = build();
      const res = await app.request("/accounts", {
        headers: {
          authorization: "Bearer uid-alice",
          "x-request-id": "trace-accounts-1",
        },
      });
      expect(res.headers.get("x-request-id")).toBe("trace-accounts-1");
    });
  });

  describe("buildAccountsApp — mount-at-root composition", () => {
    function mount(): Hono {
      const root = createApp();
      registerErrorHandlers(root as unknown as Hono<never>);
      root.use("*", httpLogger());
      // Canonical v4 wiring: each module is its own sub-app, mounted at root
      // with its absolute paths intact.
      root.route("/", buildAccountsApp({ service, provider }) as unknown as Hono);
      return root as unknown as Hono;
    }

    it("dispatches mounted routes through the root's middleware chain", async () => {
      const app = mount();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(200);
    });

    it("tags every captured route with the `accounts` module", () => {
      mount();
      for (const path of ["/accounts", "/accounts/:id"]) {
        expect(routeRegistry.find("GET", path)?.module).toBe("accounts");
      }
    });

    it("root error handling still shapes errors from a mounted sub-app route", async () => {
      alice.permissions = new Set([]);
      const app = mount();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer uid-alice" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("AUTHORIZATION_ERROR");
    });

    it("root httpLogger's x-request-id propagates into a mounted sub-app route", async () => {
      const app = mount();
      const res = await app.request("/accounts", {
        headers: { authorization: "Bearer uid-alice", "x-request-id": "trace-mounted-1" },
      });
      expect(res.headers.get("x-request-id")).toBe("trace-mounted-1");
    });
  });
});
