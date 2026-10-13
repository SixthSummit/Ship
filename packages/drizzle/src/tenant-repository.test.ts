import {
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  operationActor,
} from "@sixthsummit/ship-core";
import { PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createTenantRepository, tenantPredicate } from "./tenant-repository.js";

const records = pgTable("tenant_repository_records", {
  tenantId: text("tenantId").notNull(),
});
const dialect = new PgDialect();
const actor = operationActor({ id: "operator-1" });
const scopeAuthority = createTenantScopeAuthority({
  id: "accounts.tenant-scope",
  authorize: () => true,
});

function issueTenantScope(tenantId = "tenant-a") {
  return scopeAuthority.issue({ tenantId, requestId: "request-1", actor });
}

describe("createTenantRepository", () => {
  it("constructs a scoped repository only from authentic tenant evidence", async () => {
    const transaction = { id: "transaction-1" };
    const createScoped = vi.fn(({ scope }) => ({ tenantId: scope.tenantId }));
    const factory = createTenantRepository({
      id: "accounts.repository",
      transaction,
      createScoped,
    });
    const scope = await issueTenantScope();

    expect(factory.forTenant(scope)).toEqual({ tenantId: "tenant-a" });
    expect(factory).toMatchObject({
      kind: "ship.drizzle.tenant-repository",
      id: "accounts.repository",
    });
    expect(Object.isFrozen(factory)).toBe(true);
    expect(createScoped).toHaveBeenCalledWith({ transaction, scope });
    expect(Object.isFrozen(createScoped.mock.calls[0]![0])).toBe(true);
    expect(() =>
      factory.forTenant({
        kind: "ship.tenant-scope",
        tenantId: "tenant-a",
        requestId: "request-1",
        actorId: "operator-1",
      } as never),
    ).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED",
        repositoryId: "accounts.repository",
        accessMode: "scoped",
      }),
    );
  });

  it("separates privileged repository construction and audits every use", () => {
    const events: unknown[] = [];
    const authority = createTenantBypassAuthority({
      id: "platform.tenant-bypass",
      audit: (event) => events.push(event),
    });
    const bypass = authority.issue({
      requestId: "request-2",
      actor,
      reason: "merge duplicate tenants",
    });
    const createPrivileged = vi.fn(({ bypass: evidence }) => ({ evidence }));
    const factory = createTenantRepository({
      id: "accounts.repository",
      transaction: { id: "transaction-1" },
      createScoped: ({ scope }) => ({ tenantId: scope.tenantId }),
      createPrivileged,
    });

    expect(factory.withBypass(bypass)).toEqual({ evidence: bypass });
    expect(createPrivileged).toHaveBeenCalledWith(expect.objectContaining({ bypass }));
    expect(events).toEqual([
      expect.objectContaining({ action: "issued" }),
      expect.objectContaining({
        action: "repository-accessed",
        repositoryId: "accounts.repository",
      }),
    ]);
    expect(() => factory.withBypass({ ...bypass } as never)).toThrowError(
      expect.objectContaining({ code: "SHIP_TENANT_BYPASS_REQUIRED" }),
    );
  });

  it("does not expose privileged construction when it was not declared", () => {
    const factory = createTenantRepository({
      id: "accounts.repository",
      transaction: {},
      createScoped: ({ scope }) => ({ tenantId: scope.tenantId }),
    });

    expect(Reflect.has(factory, "withBypass")).toBe(false);
  });

  it.each([
    [null, undefined, undefined],
    [{ id: "Bad ID", transaction: {}, createScoped: () => ({}) }, "id", "Bad ID"],
    [
      { id: "accounts.repository", transaction: null, createScoped: () => ({}) },
      "transaction",
      "accounts.repository",
    ],
    [
      { id: "accounts.repository", transaction: [], createScoped: () => ({}) },
      "transaction",
      "accounts.repository",
    ],
    [
      { id: "accounts.repository", transaction: {}, createScoped: true },
      "createScoped",
      "accounts.repository",
    ],
    [
      {
        id: "accounts.repository",
        transaction: {},
        createScoped: () => ({}),
        createPrivileged: true,
      },
      "createPrivileged",
      "accounts.repository",
    ],
  ])("rejects an invalid tenant repository definition %#", (definition, field, repositoryId) => {
    expect(() => createTenantRepository(definition as never)).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
        field,
        repositoryId,
      }),
    );
  });

  it.each([
    [undefined, "scoped"],
    [Promise.resolve({}), "scoped"],
  ])("rejects an invalid scoped repository result %#", async (result, accessMode) => {
    const factory = createTenantRepository({
      id: "accounts.repository",
      transaction: {},
      createScoped: () => result as never,
    });
    const scope = await issueTenantScope();

    expect(() => factory.forTenant(scope)).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
        repositoryId: "accounts.repository",
        accessMode,
      }),
    );
  });

  it("rejects an invalid privileged repository result after auditing access", () => {
    const events: unknown[] = [];
    const bypass = createTenantBypassAuthority({
      id: "platform.bypass",
      audit: (event) => events.push(event),
    }).issue({ requestId: "request", actor, reason: "support" });
    const factory = createTenantRepository({
      id: "accounts.repository",
      transaction: {},
      createScoped: () => ({}),
      createPrivileged: () => Promise.resolve({}),
    });

    expect(() => factory.withBypass(bypass)).toThrowError(
      expect.objectContaining({
        code: "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
        accessMode: "privileged",
      }),
    );
    expect(events).toHaveLength(2);
  });
});

describe("tenantPredicate", () => {
  it("renders a tenant equality predicate", async () => {
    const scope = await issueTenantScope();
    const rendered = dialect.sqlToQuery(tenantPredicate(records.tenantId, scope));

    expect(rendered.sql).toBe('"tenant_repository_records"."tenantId" = $1');
    expect(rendered.params).toEqual(["tenant-a"]);
  });

  it("rejects structurally forged tenant evidence", () => {
    expect(() =>
      tenantPredicate(records.tenantId, {
        kind: "ship.tenant-scope",
        tenantId: "tenant-a",
        requestId: "request-1",
        actorId: "operator-1",
      } as never),
    ).toThrowError(expect.objectContaining({ code: "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED" }));
  });
});
