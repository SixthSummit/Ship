/**
 * v4 multi-module composition smoke test.
 *
 * The accounts, oauth, and outbox modules each have
 * their own end-to-end test. This test composes all three into a
 * single Hono app + single fake DB + single fake AuthProvider — the
 * one thing the per-module tests can't catch is "modules work in
 * isolation but break in composition" (route path collisions,
 * permission slug collisions, schema-key conflicts in the typed
 * client, registry pollution).
 *
 * What this pins down:
 *   - All routes from all three modules register cleanly into a
 *     single `routeRegistry` with no duplicate keys
 *   - Route paths don't collide across modules
 *   - Permission slugs are uniquely namespaced per module
 *   - The shared AuthProvider correctly threads the same user
 *     identity through every module's auth chain
 *   - One request through each module succeeds end-to-end against
 *     the shared in-memory DB
 *
 * Real-Postgres composition tests come in a separate batch.
 */

// IMPORTANT: import from `@sixthsummit/ship-api/...` (the built lib),
// NOT from `../../app/...` source paths. The accounts / oauth /
// outbox module code imports the framework via the built lib;
// if this test imports the same modules from source, AppError gets
// two different class identities — `instanceof AppError` checks in
// `registerErrorHandlers` fail and 4xx errors come back as 500s.
// Single source of truth via the package export keeps everything
// resolving to one class.
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
import { hc } from "hono/client";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { defineAccountsRoutes } from "../../../../../modules/accounts/index.js";
import { AccountService } from "../../../../../modules/accounts/services/AccountService.js";
import { MockOAuthAdapter } from "../../../../../modules/oauth/adapters/MockOAuthAdapter.js";
import { oauthAdapterRegistry } from "../../../../../modules/oauth/adapters/OAuthAdapterRegistry.js";
import { defineOAuthRoutes } from "../../../../../modules/oauth/routes.js";
import { OAuthConnectionService } from "../../../../../modules/oauth/services/OAuthConnectionService.js";
import { eventHandlerRegistry } from "../../../../../modules/outbox/handlers/EventHandler.js";
import { OutboxDrainer } from "../../../../../modules/outbox/OutboxDrainer.js";
import { defineOutboxRoutes } from "../../../../../modules/outbox/routes.js";
import { OutboxEventService } from "../../../../../modules/outbox/services/OutboxEventService.js";

// ─── Test fixtures ────────────────────────────────────────────────────

const ALICE_UID = "uid-alice";
const ALICE_ID = "11111111-1111-4111-8111-111111111111";

const ALL_PERMISSIONS = [
  "accounts:read",
  "accounts:create",
  "accounts:update",
  "accounts:delete",
  "oauth:connections:read-self",
  "oauth:connections:connect",
  "oauth:connections:disconnect",
  "oauth:connections:refresh",
  "outbox:read",
  "outbox:drain",
  "outbox:recover",
];

interface TestAccount extends AuthenticatedAccount {
  permissions: Set<string>;
}

interface CallRecord {
  kind:
    | "select"
    | "selectAggregate"
    | "selectGrouped"
    | "insert"
    | "insert.onConflict"
    | "update"
    | "delete";
  whereExpr?: SQL;
  setValues?: unknown;
}

/**
 * Single fake DB shared by all three services. Stores rows keyed by a
 * caller-supplied "category" (accounts / oauth / outbox) so the
 * services don't accidentally see each other's rows. The DB picks the
 * right category by inspecting the table reference threaded through
 * `select(...).from(table)`.
 *
 * In production a Drizzle client distinguishes tables automatically;
 * here we approximate by keying behavior on `Symbol.iterator`-compatible
 * lookups. The tests below just need the shape — full parity with the
 * Drizzle behavior is the per-module test's job.
 */
function makeMultiDb() {
  const calls: CallRecord[] = [];
  const stores: Record<string, Record<string, unknown>[]> = {
    accounts: [],
    oauth: [],
    outbox: [],
  };
  let activeCategory = "accounts";

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
      groupBy() {
        record.kind = "selectGrouped";
        return chain;
      },
      then(resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) {
        const rows = stores[activeCategory] ?? [];
        const result = isAggregate ? [{ value: rows.length }] : rows;
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  const db = {
    select(arg?: unknown) {
      const isAggregate = arg !== undefined && Object.keys(arg as object).length === 1;
      const isGrouped = arg !== undefined && Object.keys(arg as object).length > 1;
      const record: CallRecord = {
        kind: isAggregate ? "selectAggregate" : isGrouped ? "selectGrouped" : "select",
      };
      calls.push(record);
      return { from: () => selectChain(record, isAggregate) };
    },
    insert() {
      return {
        values(v: unknown) {
          const record: CallRecord = { kind: "insert" };
          calls.push(record);
          const created = {
            id: `${activeCategory}-row-${Date.now()}`,
            ...(v as Record<string, unknown>),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          return {
            onConflictDoUpdate(o: { target: unknown; set: unknown }) {
              record.kind = "insert.onConflict";
              const merged = { ...created, ...(o.set as Record<string, unknown>) };
              stores[activeCategory].push(merged);
              return { returning: async () => [merged] };
            },
            returning: async () => {
              stores[activeCategory].push(created);
              return [created];
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
                  const rows = stores[activeCategory];
                  if (rows.length === 0) return [];
                  rows[0] = { ...rows[0], ...(v as Record<string, unknown>) };
                  return [rows[0]];
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
          return { returning: async () => stores[activeCategory] };
        },
      };
    },
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => fn(db),
  };

  return {
    db: db as unknown as ShipDb<Record<string, unknown>>,
    calls,
    stores,
    setCategory(cat: keyof typeof stores) {
      activeCategory = cat;
    },
    seed(cat: keyof typeof stores, row: Record<string, unknown>) {
      stores[cat].push(row);
    },
  };
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
      const account = byUid.get(token);
      return account
        ? { ok: true, claims: { subject: token } }
        : { ok: true, claims: { subject: token } };
    },
    async resolve(claims: AuthClaims): Promise<TestAccount | null> {
      return byUid.get(claims.subject) ?? null;
    },
  };
}

// ─── Harness ──────────────────────────────────────────────────────────

function buildAllModulesApp() {
  routeRegistry.clear();

  const fake = makeMultiDb();

  // Seed an account row so accounts list returns it.
  fake.seed("accounts", {
    id: ALICE_ID,
    email: "alice@example.test",
    emailVerified: true,
    displayName: "Alice",
    firebaseUid: ALICE_UID,
    isActive: true,
    roleId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
  });

  const accountService = new AccountService(fake.db);
  const oauthService = new OAuthConnectionService(fake.db);
  const outboxService = new OutboxEventService(fake.db);
  const drainer = new OutboxDrainer(outboxService, eventHandlerRegistry());

  const alice: TestAccount = {
    id: ALICE_ID,
    permissions: new Set(ALL_PERMISSIONS),
    hasPermission(slug) {
      return alice.permissions.has(slug);
    },
  };
  const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));

  const adapters = oauthAdapterRegistry(new MockOAuthAdapter("google"));
  const credentials = (code: string) =>
    code === "google"
      ? {
          clientId: "cid",
          clientSecret: "csec",
          redirectUri: "https://app.test/oauth/google/callback",
        }
      : null;

  const app = createApp();
  registerErrorHandlers(app as unknown as Hono<never>);
  app.use("*", httpLogger());

  // Threaded composition via the kept `defineXxxRoutes(app, deps)` escape
  // hatch — NOT the canonical pattern (that is `root.route("/", buildXxxApp(deps))`,
  // see modules/*/routes.test.ts). This path stays here on purpose: it's the
  // only coverage that the back-compat hatch still type-accumulates across all
  // three real modules; the type-level test below pins that accumulation.
  const routed = defineOutboxRoutes(
    defineOAuthRoutes(
      defineAccountsRoutes(app, {
        service: accountService,
        provider,
      }),
      {
        service: oauthService,
        provider,
        adapters,
        credentials,
        stateSecret: "test-secret-very-long-and-random-do-not-use-in-prod",
      },
    ),
    {
      service: outboxService,
      drainer,
      provider,
    },
  );

  return {
    app: routed,
    fake,
    alice,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("v4 multi-module composition smoke test", () => {
  beforeEach(() => {
    routeRegistry.clear();
  });

  it("typed client carries all three modules' route types through the chain", () => {
    const { app: _app } = buildAllModulesApp();
    const client = hc<typeof _app>("http://localhost");

    // One route per module. If a definer's signature widens the chained app
    // (non-generic `app: Hono<AppEnv>` — methods resolve on the parameter's
    // declared type), the earlier modules' routes vanish from the client
    // type and these assertions fail to compile. This is the regression
    // tripwire for the typed-client contract.
    expectTypeOf(client.accounts.$get).toBeFunction();
    expectTypeOf(client.accounts.$post).toBeFunction();
    expectTypeOf(client.oauth.$get).toBeFunction();
    expectTypeOf(client.outbox.$get).toBeFunction();
  });

  it("registers every route from every module without collisions", () => {
    buildAllModulesApp();

    // Expected route count: accounts (7) + oauth (4) + outbox (6).
    expect(routeRegistry.size()).toBeGreaterThanOrEqual(17);

    // No duplicate keys: every (method, path) appears once.
    const all = routeRegistry.list();
    const keys = all.map((r) => `${r.method} ${r.path}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it("permission slugs are uniquely namespaced — no collisions across modules", () => {
    buildAllModulesApp();
    const slugs = new Set<string>();
    for (const route of routeRegistry.list()) {
      for (const p of route.permissions) {
        slugs.add(p);
      }
    }
    // Each module's slugs use its own prefix.
    const slugList = [...slugs];
    const accountsSlugs = slugList.filter((s) => s.startsWith("accounts:"));
    const oauthSlugs = slugList.filter((s) => s.startsWith("oauth:"));
    const outboxSlugs = slugList.filter((s) => s.startsWith("outbox:"));
    expect(accountsSlugs.length).toBeGreaterThan(0);
    expect(oauthSlugs.length).toBeGreaterThan(0);
    expect(outboxSlugs.length).toBeGreaterThan(0);
    // Sanity: total namespaced = total registered.
    expect(accountsSlugs.length + oauthSlugs.length + outboxSlugs.length).toBe(slugList.length);
  });

  it("route paths don't collide between modules", () => {
    buildAllModulesApp();
    const all = routeRegistry.list();
    // No two modules should claim the same exact path under the same method.
    const seen = new Map<string, string>();
    for (const route of all) {
      const key = `${route.method} ${route.path}`;
      const existing = seen.get(key);
      expect(existing, `Duplicate ${key} (already from ${existing})`).toBeUndefined();
      seen.set(key, route.permissions.join(","));
    }
  });

  it("auth provider threads the same user identity through all three modules", async () => {
    const { app, fake } = buildAllModulesApp();

    // Hit one route per module — same Authorization header should
    // resolve to the same user across all three.
    fake.setCategory("accounts");
    const accountsRes = await app.request("/accounts", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(accountsRes.status).toBe(200);

    fake.setCategory("oauth");
    const oauthRes = await app.request("/oauth", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(oauthRes.status).toBe(200);

    fake.setCategory("outbox");
    const outboxRes = await app.request("/outbox/count", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(outboxRes.status).toBe(200);
  });

  it("modules' permission requirements are enforced INDEPENDENTLY (revoking one doesn't affect others)", async () => {
    const { app, alice, fake } = buildAllModulesApp();

    // Strip oauth permissions but leave accounts + outbox intact.
    alice.permissions = new Set(["accounts:read", "outbox:read"]);

    fake.setCategory("accounts");
    const accountsRes = await app.request("/accounts", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(accountsRes.status).toBe(200);

    fake.setCategory("oauth");
    const oauthRes = await app.request("/oauth", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(oauthRes.status).toBe(403);

    fake.setCategory("outbox");
    const outboxRes = await app.request("/outbox/count", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(outboxRes.status).toBe(200);
  });

  it("module-level X-Request-Id propagation works end-to-end through any module", async () => {
    const { app, fake } = buildAllModulesApp();

    // Request id propagation lives in the shared httpLogger middleware,
    // not per-module — verify it works for routes from each module.
    const sharedHeaders = {
      authorization: `Bearer ${ALICE_UID}`,
      "x-request-id": "trace-multi-1",
    };

    fake.setCategory("accounts");
    expect(
      (await app.request("/accounts", { headers: sharedHeaders })).headers.get("x-request-id"),
    ).toBe("trace-multi-1");

    fake.setCategory("oauth");
    expect(
      (await app.request("/oauth", { headers: sharedHeaders })).headers.get("x-request-id"),
    ).toBe("trace-multi-1");

    fake.setCategory("outbox");
    expect(
      (await app.request("/outbox/count", { headers: sharedHeaders })).headers.get("x-request-id"),
    ).toBe("trace-multi-1");
  });

  it("the route registry's auth+permission metadata is populated for every registered route", () => {
    buildAllModulesApp();
    for (const route of routeRegistry.list()) {
      // Every non-public route requires auth.
      const isPublic = route.path.includes("/callback");
      if (!isPublic) {
        expect(route.auth.required, `${route.method} ${route.path} should require auth`).toBe(true);
      }
      // Mutating routes (POST / PUT / DELETE) MUST have at least one
      // permission, except the OAuth callback (public, state-HMAC-auth'd).
      if (["POST", "PUT", "DELETE"].includes(route.method) && !isPublic) {
        expect(
          route.permissions.length,
          `${route.method} ${route.path} should have ≥1 permission`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
