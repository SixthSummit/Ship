/**
 * v4 canonical reference: the `me` module wired end-to-end.
 *
 * This is the alpha-1 milestone deliverable — a complete v4 module exercised
 * through the full middleware chain (httpLogger → requireAuth →
 * requirePermission → validate → handler) against a fake Drizzle-shaped DB
 * and a fake AuthProvider.
 *
 * What this test pins down for the rest of v4:
 * - `createApp()` registers routes into the route registry with full metadata
 * - `requireAuth({ provider })` runs the AuthProvider chain and sets `c.get('user')`
 * - `requirePermission(slug)` enforces against the resolved Account
 * - `validate('query', schema)` validates inputs and rejects invalid ones
 *   through the AppError taxonomy
 * - `DrizzleEntityService<typeof accounts>` reads via `db.select().from(...)`
 *   with soft-delete + audit-column behavior
 * - `registerErrorHandlers(app)` produces the consistent JSON shape on errors
 * - `httpLogger()` propagates the request ID into RequestContext for downstream
 *
 * It also stands as documentation: read this test to understand exactly what a
 * v4 module looks like end-to-end.
 *
 * Real-Postgres integration via testcontainers comes in a separate batch.
 */

import type { SQL } from "drizzle-orm";
import { boolean, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import type { Hono, Schema } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AuthClaims,
  AuthenticatedAccount,
  AuthProvider,
  AuthProviderContext,
  AuthVerifyResult,
} from "../../app/auth/AuthProvider.js";
import { baseFields } from "../../app/db/baseFields.js";
import type { ShipDb } from "../../app/db/client.js";
import { routeRegistry } from "../../app/registry/routes.js";
import { DrizzleEntityService } from "../../app/services/DrizzleEntityService.js";
import { type AppEnv, createApp } from "../../http/app/createApp.js";
import { registerErrorHandlers } from "../../http/app/errors.js";
import { httpLogger } from "../../http/middleware/httpLogger.js";
import { requireAuth } from "../../http/middleware/requireAuth.js";
import { requirePermission } from "../../http/middleware/requirePermission.js";
import { validate } from "../../http/utils/validate.js";

// Local fixture table — this framework reference test exercises
// `DrizzleEntityService` against a `baseFields`-bearing table. It deliberately
// does NOT depend on the accounts module's schema (identity tables live in
// `modules/accounts` now); any such table demonstrates the same end-to-end
// pattern.
const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull(),
  displayName: varchar("display_name", { length: 200 }),
  isActive: boolean("is_active").notNull().default(true),
  ...baseFields,
});

// ─────────────────────────────────────────────────────────────────────────
// Fake Drizzle DB — mirrors the shape DrizzleEntityService.test.ts uses
// ─────────────────────────────────────────────────────────────────────────

interface CallRecord {
  kind: "select" | "selectAggregate";
  whereExpr?: SQL;
  limit?: number;
}

function makeFakeDb(rows: unknown[]) {
  const calls: CallRecord[] = [];
  function makeChain(record: CallRecord, isCount: boolean) {
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
      offset() {
        return chain;
      },
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        const result = isCount ? [{ value: rows.length }] : rows;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  const db = {
    select(arg?: unknown) {
      const isAggregate = arg !== undefined;
      const record: CallRecord = { kind: isAggregate ? "selectAggregate" : "select" };
      calls.push(record);
      return {
        from: () => makeChain(record, isAggregate),
      };
    },
  };
  return { db: db as unknown as ShipDb<{ accounts: typeof accounts }>, calls };
}

// ─────────────────────────────────────────────────────────────────────────
// MeService — extends DrizzleEntityService against the default `accounts`
// ─────────────────────────────────────────────────────────────────────────

class MeService extends DrizzleEntityService<typeof accounts, { accounts: typeof accounts }> {
  protected getTable() {
    return accounts;
  }
  protected override getDefaultSearchFields(): readonly string[] {
    return ["email", "displayName"];
  }

  /** Real implementation would also pull `role.permissions` via Drizzle's
   *  relational query API; for the alpha-1 reference we use the basic
   *  select() path that's fully covered by unit tests. */
  async getCurrentAccount(accountId: string) {
    return this.get(accountId);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Fake AuthProvider — mirrors what FirebaseAuthProvider does in production
// ─────────────────────────────────────────────────────────────────────────

interface MeAccount extends AuthenticatedAccount {
  email: string;
  displayName: string;
  permissions: Set<string>;
}

function fakeAuthProvider(accountsByUid: Map<string, MeAccount>): AuthProvider<MeAccount> {
  return {
    name: "fake-firebase",
    onMissingToken: "reject",
    async verify(ctx: AuthProviderContext): Promise<AuthVerifyResult> {
      const auth = ctx.headers.authorization;
      if (!auth) return { ok: false, reason: "missing-token", message: "no Authorization header" };
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if (token === "expired") return { ok: false, reason: "expired-token", message: "expired" };
      if (!accountsByUid.has(token)) return { ok: true, claims: { subject: token } };
      return { ok: true, claims: { subject: token, email: accountsByUid.get(token)!.email } };
    },
    async resolve(claims: AuthClaims): Promise<MeAccount | null> {
      return accountsByUid.get(claims.subject) ?? null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// me module — what every v4 module looks like
// ─────────────────────────────────────────────────────────────────────────

const meQuerySchema = z.object({
  includeRole: z.enum(["true", "false"]).optional(),
});

// Schema-generic + returns the chained app — the v4 module contract. A
// non-generic `app: Hono<AppEnv>` would widen an already-chained app and a
// discarded return would drop the route from the hc<>() client type.
function defineMeRoutes<S extends Schema>(
  app: Hono<AppEnv, S>,
  deps: { service: MeService; provider: AuthProvider<MeAccount> },
) {
  return app.get(
    "/me",
    requireAuth({ provider: deps.provider }),
    requirePermission("me:read"),
    validate("query", meQuerySchema),
    async (c) => {
      const user = c.get("user" as never) as MeAccount;
      const account = await deps.service.getCurrentAccount(user.id);
      if (account === null) return c.json({ error: "not found" }, 404);
      return c.json(account, 200);
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("v4 canonical reference: me module end-to-end", () => {
  let alice: MeAccount;
  let provider: AuthProvider<MeAccount>;
  let service: MeService;
  let dbCalls: CallRecord[];

  beforeEach(() => {
    routeRegistry.clear();

    alice = {
      id: "a-1",
      email: "alice@example.com",
      displayName: "Alice",
      permissions: new Set(["me:read", "accounts:list"]),
      hasPermission(slug: string) {
        return alice.permissions.has(slug);
      },
    };

    const aliceUid = "uid-alice";
    const aliceRow = { ...alice, firebaseUid: aliceUid, deletedAt: null };
    const fake = makeFakeDb([aliceRow]);
    dbCalls = fake.calls;
    service = new MeService(fake.db);

    const accountsByUid = new Map<string, MeAccount>([[aliceUid, alice]]);
    provider = fakeAuthProvider(accountsByUid);
  });

  function build() {
    const app = createApp();
    registerErrorHandlers(app as unknown as Hono<never>);
    app.use("*", httpLogger());
    return defineMeRoutes(app, { service, provider });
  }

  it("registers GET /me with full metadata in the route registry", () => {
    build();
    const entry = routeRegistry.find("GET", "/me");
    expect(entry).toBeDefined();
    expect(entry!.auth).toEqual({ required: true, provider: "fake-firebase" });
    expect(entry!.permissions).toEqual(["me:read"]);
    expect(entry!.schemas.query).toBe(meQuerySchema);
  });

  it("returns 401 when the request has no Authorization header", async () => {
    const app = build();
    const res = await app.request("/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: false; error: { code: string } };
    expect(body.error.code).toBe("AUTHENTICATION_ERROR");
  });

  it("returns 401 with the present-but-bad token shape", async () => {
    const app = build();
    const res = await app.request("/me", { headers: { authorization: "Bearer expired" } });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the resolved user lacks the required permission", async () => {
    alice.permissions = new Set([]); // strip me:read
    const app = build();
    const res = await app.request("/me", { headers: { authorization: "Bearer uid-alice" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("AUTHORIZATION_ERROR");
    expect(body.error.message).toMatch(/me:read/);
  });

  it("returns 200 with the account when authorized", async () => {
    const app = build();
    const res = await app.request("/me", { headers: { authorization: "Bearer uid-alice" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.id).toBe("a-1");
    expect(body.email).toBe("alice@example.com");
  });

  it("propagates the request ID through the chain (X-Request-Id echoed)", async () => {
    const app = build();
    const res = await app.request("/me", {
      headers: { authorization: "Bearer uid-alice", "x-request-id": "trace-1" },
    });
    expect(res.headers.get("x-request-id")).toBe("trace-1");
  });

  it("validates query strings via zValidator (rejects unknown enum value)", async () => {
    const app = build();
    const res = await app.request("/me?includeRole=maybe", {
      headers: { authorization: "Bearer uid-alice" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("hits the DrizzleEntityService.get path with soft-delete filter applied", async () => {
    const app = build();
    await app.request("/me", { headers: { authorization: "Bearer uid-alice" } });

    // service.get was invoked, and DrizzleEntityService composed where:
    //   accounts.id = $id  AND  accounts.deleted_at IS NULL
    // (See DrizzleEntityService.test.ts for the full contract.)
    expect(dbCalls.length).toBeGreaterThan(0);
    expect(dbCalls[0].whereExpr).toBeDefined();
    expect(dbCalls[0].limit).toBe(1);
  });
});
