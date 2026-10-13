/**
 * v4 outbox module — end-to-end route integration test.
 *
 * Same chain as accounts/routes.test.ts and oauth/routes.test.ts:
 * httpLogger → requireAuth → requirePermission → validate → handler →
 * service. This test pins the full outbox port: schema, service,
 * orchestration (drainer), and routes.
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

import { type EventHandler, eventHandlerRegistry } from "./handlers/EventHandler.js";
import { OutboxDrainer } from "./OutboxDrainer.js";
import { buildOutboxApp, defineOutboxRoutes } from "./routes.js";
import type { outboxEvents } from "./schema.js";
import { OutboxEventService } from "./services/OutboxEventService.js";

const ALICE_UID = "uid-alice";
const ALICE_ID = "11111111-1111-4111-8111-111111111111";

interface CallRecord {
  kind: "select" | "selectAggregate" | "selectGrouped" | "insert" | "update" | "delete";
  whereExpr?: SQL;
  setValues?: unknown;
  groupByCalled?: boolean;
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
      groupBy() {
        record.groupByCalled = true;
        record.kind = "selectGrouped";
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
        values(_v: unknown) {
          const record: CallRecord = { kind: "insert" };
          calls.push(record);
          return { returning: async () => store };
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
                returning() {
                  return Promise.resolve(store);
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
    db: db as unknown as ShipDb<{ outboxEvents: typeof outboxEvents }>,
    calls,
    rows: () => store,
    seed(extra: Record<string, unknown>) {
      store.push(extra);
    },
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

const sampleEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  eventId: "33333333-3333-4333-8333-333333333333",
  eventType: "account.created",
  eventVersion: 1,
  occurredAt: new Date("2025-06-01T00:00:00Z"),
  aggregateType: "account",
  aggregateId: "44444444-4444-4444-8444-444444444444",
  ownerUserId: null,
  tenantId: null,
  dedupeKey: null,
  correlationId: "trace-1",
  payload: { large: "x".repeat(100), id: "44444444-4444-4444-8444-444444444444" },
  status: "pending",
  publishAttempts: 0,
  nextAttemptAt: null,
  publishedAt: null,
  lastError: null,
  maxRetries: 10,
  startedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
};

function buildHarness(opts: { rows?: Record<string, unknown>[] } = {}) {
  routeRegistry.clear();

  const fakeDb = makeFakeDb(opts.rows ?? [sampleEvent]);
  const service = new OutboxEventService(fakeDb.db);
  const handlers: EventHandler[] = [
    {
      eventType: "account.created",
      handle: async () => undefined,
    },
  ];
  const drainer = new OutboxDrainer(service, eventHandlerRegistry(...handlers));

  const alice: TestAccount = {
    id: ALICE_ID,
    permissions: new Set(["outbox:read", "outbox:drain", "outbox:recover"]),
    hasPermission(slug) {
      return alice.permissions.has(slug);
    },
  };
  const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));

  const app = createApp();
  registerErrorHandlers(app as unknown as Hono<never>);
  app.use("*", httpLogger());
  defineOutboxRoutes(app as unknown as Hono, { service, drainer, provider });

  return {
    app: app as unknown as Hono,
    fakeDb,
    service,
    drainer,
    alice,
  };
}

describe("v4 outbox routes — end-to-end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("route registry capture", () => {
    it("registers all 6 routes with auth + permission metadata", () => {
      buildHarness();
      const expected = [
        ["GET", "/outbox", "outbox:read"],
        ["GET", "/outbox/stats", "outbox:read"],
        ["GET", "/outbox/count", "outbox:read"],
        ["GET", "/outbox/:id", "outbox:read"],
        ["POST", "/outbox/drain", "outbox:drain"],
        ["POST", "/outbox/recover", "outbox:recover"],
      ] as const;
      for (const [method, path, perm] of expected) {
        const entry = routeRegistry.find(method, path);
        expect(entry, `${method} ${path}`).toBeDefined();
        expect(entry!.auth.required, `${method} ${path} auth`).toBe(true);
        expect(entry!.permissions, `${method} ${path} perm`).toContain(perm);
      }
    });
  });

  describe("authentication + authorization", () => {
    it("401 without Authorization on read endpoints", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox");
      expect(res.status).toBe(401);
    });

    it("403 without read permission on list", async () => {
      const { app, alice } = buildHarness();
      alice.permissions = new Set([]);
      const res = await app.request("/outbox", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(403);
    });

    it("403 on drain without the drain permission (read alone insufficient)", async () => {
      const { app, alice } = buildHarness();
      alice.permissions = new Set(["outbox:read"]);
      const res = await app.request("/outbox/drain", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it("403 on recover without the recover permission", async () => {
      const { app, alice } = buildHarness();
      alice.permissions = new Set(["outbox:read", "outbox:drain"]);
      const res = await app.request("/outbox/recover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /outbox (list)", () => {
    it("returns sanitized rows with pagination metadata", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<Record<string, unknown>>;
        total: number;
        page: number;
        perPage: number;
      };
      expect(body.page).toBe(1);
      expect(body.perPage).toBe(50);
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].id).toBe(sampleEvent.id);
      expect(body.rows[0].eventType).toBe("account.created");
    });

    it("supports filters (eventType, status) via query params", async () => {
      const { app } = buildHarness();
      const res = await app.request(
        "/outbox?eventType=account.created&status=pending&page=2&perPage=10",
        { headers: { authorization: `Bearer ${ALICE_UID}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        page: number;
        perPage: number;
      };
      expect(body.page).toBe(2);
      expect(body.perPage).toBe(10);
    });

    it("rejects perPage above 200 (cap)", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox?perPage=1000", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid status enum value", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox?status=zzz", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /outbox/stats", () => {
    it("returns the per-status aggregate counts", async () => {
      const { app, fakeDb } = buildHarness({
        rows: [
          { status: "pending", count: 3 },
          { status: "published", count: 100 },
          { status: "failed", count: 1 },
        ],
      });
      // Recreate the service against the new fake (with stats rows).
      // The buildHarness override shape is enough — calls go through.
      void fakeDb;
      const res = await app.request("/outbox/stats", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(200);
      const stats = (await res.json()) as Record<string, number>;
      expect(stats).toEqual({
        pending: 3,
        processing: 0,
        published: 100,
        failed: 1,
      });
    });
  });

  describe("GET /outbox/count", () => {
    it("returns { count }", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox/count", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(1);
    });
  });

  describe("GET /outbox/:id", () => {
    it("returns the full event including payload", async () => {
      const { app } = buildHarness();
      const res = await app.request(`/outbox/${sampleEvent.id}`, {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(sampleEvent.id);
      expect(body.payload).toBeDefined();
    });

    it("404 when not found", async () => {
      const { app } = buildHarness({ rows: [] });
      const res = await app.request("/outbox/55555555-5555-4555-8555-555555555555", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(404);
    });

    it("400 for non-uuid param", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox/not-a-uuid", {
        headers: { authorization: `Bearer ${ALICE_UID}` },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /outbox/drain", () => {
    it("triggers a drain pass and returns the structured result", async () => {
      const { app, drainer } = buildHarness({ rows: [] });
      const drainSpy = vi.spyOn(drainer, "runOnce").mockResolvedValue({
        processed: 5,
        published: 4,
        failed: 0,
        retried: 1,
        skippedNoHandler: 0,
      });

      const res = await app.request("/outbox/drain", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ batchSize: 25 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, number>;
      expect(body).toEqual({
        processed: 5,
        published: 4,
        failed: 0,
        retried: 1,
        skippedNoHandler: 0,
      });
      expect(drainSpy).toHaveBeenCalledWith({ batchSize: 25 });
    });

    it("untilEmpty=true uses runUntilEmpty instead of runOnce", async () => {
      const { app, drainer } = buildHarness({ rows: [] });
      const onceSpy = vi.spyOn(drainer, "runOnce");
      const untilEmptySpy = vi.spyOn(drainer, "runUntilEmpty").mockResolvedValue({
        processed: 100,
        published: 100,
        failed: 0,
        retried: 0,
        skippedNoHandler: 0,
      });

      const res = await app.request("/outbox/drain", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ untilEmpty: true }),
      });
      expect(res.status).toBe(200);
      expect(untilEmptySpy).toHaveBeenCalledOnce();
      expect(onceSpy).not.toHaveBeenCalled();
    });

    it("400 when batchSize is over the cap", async () => {
      const { app } = buildHarness();
      const res = await app.request("/outbox/drain", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ batchSize: 99999 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /outbox/recover", () => {
    it("returns the recovered count", async () => {
      const { app, service } = buildHarness();
      vi.spyOn(service, "recoverStaleProcessing").mockResolvedValue({
        recovered: 3,
      });

      const res = await app.request("/outbox/recover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recovered: number };
      expect(body).toEqual({ recovered: 3 });
    });

    it("forwards explicit staleThresholdMs to the service", async () => {
      const { app, service } = buildHarness();
      const spy = vi.spyOn(service, "recoverStaleProcessing").mockResolvedValue({ recovered: 0 });

      await app.request("/outbox/recover", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ALICE_UID}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ staleThresholdMs: 60_000 }),
      });
      expect(spy).toHaveBeenCalledWith(60_000);
    });
  });
});

describe("buildOutboxApp — mount-at-root composition", () => {
  function mount() {
    routeRegistry.clear();
    const service = new OutboxEventService(makeFakeDb([sampleEvent]).db);
    const drainer = new OutboxDrainer(service, eventHandlerRegistry());
    const alice: TestAccount = {
      id: ALICE_ID,
      permissions: new Set(["outbox:read"]),
      hasPermission(slug) {
        return alice.permissions.has(slug);
      },
    };
    const provider = fakeAuthProvider(new Map([[ALICE_UID, alice]]));
    const root = createApp();
    registerErrorHandlers(root as unknown as Hono<never>);
    root.use("*", httpLogger());
    root.route("/", buildOutboxApp({ service, drainer, provider }) as unknown as Hono);
    return root as unknown as Hono;
  }

  it("dispatches a mounted outbox route through the root chain", async () => {
    const app = mount();
    const res = await app.request("/outbox", {
      headers: { authorization: `Bearer ${ALICE_UID}` },
    });
    expect(res.status).toBe(200);
  });

  it("tags outbox routes with the `outbox` module", () => {
    mount();
    expect(routeRegistry.find("GET", "/outbox")?.module).toBe("outbox");
    expect(routeRegistry.find("GET", "/outbox/:id")?.module).toBe("outbox");
  });
});
