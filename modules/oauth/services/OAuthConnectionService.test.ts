import type { ShipDb } from "@sixthsummit/ship-api/app/db/client";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OAuthConnection, oauthConnections } from "../schema.js";
import { OAuthConnectionService } from "./OAuthConnectionService.js";

interface CallRecord {
  kind: "select" | "selectAggregate" | "insert" | "insert.onConflict" | "update" | "delete";
  whereExpr?: SQL;
  setValues?: unknown;
  insertValues?: unknown;
  conflictTarget?: unknown;
  conflictSet?: unknown;
  limit?: number;
}

function makeFakeDb(rows: unknown[] = []) {
  const calls: CallRecord[] = [];

  function selectChain(record: CallRecord, isAggregate: boolean) {
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
      return { from: () => selectChain(record, isAggregate) };
    },
    insert() {
      return {
        values(v: unknown) {
          const record: CallRecord = { kind: "insert", insertValues: v };
          calls.push(record);
          const returningRow = {
            id: "11111111-1111-4111-8111-111111111111",
            ...(v as Record<string, unknown>),
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          };
          return {
            onConflictDoUpdate(o: { target: unknown; set: unknown }) {
              record.kind = "insert.onConflict";
              record.conflictTarget = o.target;
              record.conflictSet = o.set;
              return {
                returning: async () => [returningRow],
              };
            },
            returning: async () => [returningRow],
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
                  if (rows.length === 0) return [];
                  const row = rows[0] as Record<string, unknown>;
                  return [{ ...row, ...(v as Record<string, unknown>) }];
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
          return { returning: async () => rows };
        },
      };
    },
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => fn(db),
  };

  return {
    db: db as unknown as ShipDb<{ oauthConnections: typeof oauthConnections }>,
    calls,
  };
}

const sampleRow: OAuthConnection = {
  id: "33333333-3333-4333-8333-333333333333",
  accountId: "44444444-4444-4444-8444-444444444444",
  providerCode: "google",
  accessToken: "ya29.access",
  refreshToken: "1//refresh",
  expiresAt: new Date("2025-12-01T00:00:00Z"),
  scope: "openid profile email",
  tokenType: "Bearer",
  providerAccountId: "112233445566778899",
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
};

describe("OAuthConnectionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T00:00:00Z").getTime());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("targets the oauth_connections table", async () => {
    const fake = makeFakeDb([sampleRow]);
    const service = new OAuthConnectionService(fake.db);
    await service.getAll();
    expect(fake.calls[0].kind).toBe("select");
  });

  it("declares `account` as a default eager-load relation", () => {
    interface ProtectedSurface {
      getDefaultRelations(): readonly string[];
    }
    const fake = makeFakeDb([]);
    const service = new OAuthConnectionService(fake.db);
    const surface = service as unknown as ProtectedSurface;
    expect(surface.getDefaultRelations()).toContain("account");
  });

  it("declares providerCode + providerAccountId as default search fields", () => {
    interface ProtectedSurface {
      getDefaultSearchFields(): readonly string[];
    }
    const fake = makeFakeDb([]);
    const service = new OAuthConnectionService(fake.db);
    const surface = service as unknown as ProtectedSurface;
    expect(surface.getDefaultSearchFields()).toEqual(["providerCode", "providerAccountId"]);
  });

  describe("findByAccountAndProvider", () => {
    it("returns the row when one exists", async () => {
      const fake = makeFakeDb([sampleRow]);
      const service = new OAuthConnectionService(fake.db);
      const row = await service.findByAccountAndProvider(sampleRow.accountId, "google");
      expect(row).toEqual(sampleRow);
      const lastSelect = fake.calls.find((c) => c.kind === "select");
      expect(lastSelect?.whereExpr).toBeDefined();
      expect(lastSelect?.limit).toBe(1);
    });

    it("returns null when no row matches", async () => {
      const fake = makeFakeDb([]);
      const service = new OAuthConnectionService(fake.db);
      const row = await service.findByAccountAndProvider("missing-account", "google");
      expect(row).toBeNull();
    });
  });

  describe("upsertTokens", () => {
    it("issues an insert with onConflictDoUpdate keyed on (accountId, providerCode)", async () => {
      const fake = makeFakeDb();
      const service = new OAuthConnectionService(fake.db);

      const expiresAt = new Date("2025-06-01T01:00:00Z");
      await service.upsertTokens({
        accountId: sampleRow.accountId,
        providerCode: "google",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt,
        scope: "openid profile email",
        tokenType: "Bearer",
        providerAccountId: "112233445566778899",
        metadata: { id_token: "xyz" },
      });

      const upsert = fake.calls.find((c) => c.kind === "insert.onConflict");
      expect(upsert).toBeDefined();
      const target = upsert!.conflictTarget as unknown[];
      // Target must be the (accountId, providerCode) composite.
      expect(target).toContain(oauthConnections.accountId);
      expect(target).toContain(oauthConnections.providerCode);

      const set = upsert!.conflictSet as Record<string, unknown>;
      expect(set.accessToken).toBe("new-access");
      expect(set.refreshToken).toBe("new-refresh");
      expect(set.expiresAt).toBe(expiresAt);
      expect(set.metadata).toEqual({ id_token: "xyz" });
    });

    it("defaults metadata to {} when omitted", async () => {
      const fake = makeFakeDb();
      const service = new OAuthConnectionService(fake.db);
      await service.upsertTokens({
        accountId: sampleRow.accountId,
        providerCode: "google",
        accessToken: "tok",
      });
      const upsert = fake.calls.find((c) => c.kind === "insert.onConflict");
      const inserted = upsert!.insertValues as Record<string, unknown>;
      expect(inserted.metadata).toEqual({});
    });
  });

  describe("clearTokens (disconnect)", () => {
    it("nulls out access/refresh/expires/scope/tokenType but preserves the row", async () => {
      const fake = makeFakeDb([sampleRow]);
      const service = new OAuthConnectionService(fake.db);
      const row = await service.clearTokens(sampleRow.id);
      expect(row).toBeDefined();

      const update = fake.calls.find((c) => c.kind === "update");
      expect(update).toBeDefined();
      const set = update!.setValues as Record<string, unknown>;
      expect(set.accessToken).toBeNull();
      expect(set.refreshToken).toBeNull();
      expect(set.expiresAt).toBeNull();
      expect(set.scope).toBeNull();
      expect(set.tokenType).toBeNull();
      // No DELETE issued — row preserved for provider-account-id linkage.
      expect(fake.calls.some((c) => c.kind === "delete")).toBe(false);
    });

    it("returns null when no row matches", async () => {
      const fake = makeFakeDb([]);
      const service = new OAuthConnectionService(fake.db);
      const row = await service.clearTokens("missing-id");
      expect(row).toBeNull();
    });
  });

  describe("re-exposed status helpers", () => {
    it("isExpired / isExpiringSoon / isActive / needsRefresh / authorizationHeader are bound on the service", () => {
      const fake = makeFakeDb([]);
      const service = new OAuthConnectionService(fake.db);
      expect(typeof service.isExpired).toBe("function");
      expect(typeof service.isExpiringSoon).toBe("function");
      expect(typeof service.isActive).toBe("function");
      expect(typeof service.needsRefresh).toBe("function");
      expect(typeof service.authorizationHeader).toBe("function");

      // Sanity: helpers behave consistently with the schema-level versions.
      expect(service.isExpired({ expiresAt: new Date(Date.now() + 60_000) })).toBe(false);
      expect(
        service.authorizationHeader({
          accessToken: "abc",
          tokenType: "Bearer",
        }),
      ).toBe("Bearer abc");
    });
  });
});
