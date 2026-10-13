import {
  createTenantBypassAuthority,
  createTenantScopeAuthority,
  operationActor,
  type TenantBypassAuditEvent,
  type TenantScope,
} from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { and, asc, eq } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantRepository, tenantPredicate } from "./tenant-repository.js";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const records = pgTable("tenant_capability_records", {
  id: serial("id").primaryKey(),
  tenantId: text("tenantId").notNull(),
  title: text("title").notNull(),
});

const schema = { records };
type Schema = typeof schema;
type Transaction = DrizzleTransaction<Schema>;

class ScopedRecordsRepository {
  constructor(
    private readonly transaction: Transaction,
    private readonly scope: TenantScope<string>,
  ) {}

  async create(title: string) {
    const [row] = await this.transaction
      .insert(records)
      .values({ tenantId: this.scope.tenantId, title })
      .returning();
    return row!;
  }

  list() {
    return this.transaction
      .select()
      .from(records)
      .where(tenantPredicate(records.tenantId, this.scope))
      .orderBy(asc(records.id));
  }

  async find(id: number) {
    const [row] = await this.transaction
      .select()
      .from(records)
      .where(and(eq(records.id, id), tenantPredicate(records.tenantId, this.scope)))
      .limit(1);
    return row ?? null;
  }

  async rename(id: number, title: string): Promise<number> {
    const changed = await this.transaction
      .update(records)
      .set({ title })
      .where(and(eq(records.id, id), tenantPredicate(records.tenantId, this.scope)))
      .returning({ id: records.id });
    return changed.length;
  }
}

class PrivilegedRecordsRepository {
  constructor(private readonly transaction: Transaction) {}

  listEveryTenant() {
    return this.transaction.select().from(records).orderBy(asc(records.id));
  }

  async rename(tenantId: string, id: number, title: string): Promise<number> {
    const changed = await this.transaction
      .update(records)
      .set({ title })
      .where(and(eq(records.id, id), eq(records.tenantId, tenantId)))
      .returning({ id: records.id });
    return changed.length;
  }
}

describe("tenant repository capability integration", () => {
  let context: PostgresTestDb<Schema>;
  let events: TenantBypassAuditEvent[];

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
  });

  beforeEach(async () => {
    await truncateAll(context);
    events = [];
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  function unitOfWork() {
    return createDrizzleUnitOfWork({
      id: "database.tenant-capabilities",
      database: context.db,
      create: (transaction) => ({
        records: createTenantRepository({
          id: "records.repository",
          transaction,
          createScoped: ({ transaction: active, scope }) =>
            new ScopedRecordsRepository(active, scope),
          createPrivileged: ({ transaction: active }) => new PrivilegedRecordsRepository(active),
        }),
      }),
    });
  }

  async function seed() {
    return context.db
      .insert(records)
      .values([
        { tenantId: "tenant-a", title: "A one" },
        { tenantId: "tenant-a", title: "A two" },
        { tenantId: "tenant-b", title: "B one" },
      ])
      .returning();
  }

  it("prevents scoped reads and writes from crossing the tenant predicate", async () => {
    const seeded = await seed();
    const tenantBRecord = seeded.find(({ tenantId }) => tenantId === "tenant-b")!;
    const actor = operationActor({ id: "actor-a", permissions: ["tenant:tenant-a"] });
    const authority = createTenantScopeAuthority({
      id: "records.tenant-scope",
      authorize: ({ actor: candidate, tenantId }) =>
        candidate.permissions?.has(`tenant:${tenantId}`) ?? false,
    });
    await expect(
      authority.issue({ tenantId: "tenant-b", requestId: "request-tenant-b", actor }),
    ).rejects.toMatchObject({ code: "SHIP_TENANT_SCOPE_FORBIDDEN", tenantId: "tenant-b" });
    const scope = await authority.issue({
      tenantId: "tenant-a",
      requestId: "request-tenant-a",
      actor,
    });

    const result = await unitOfWork().run("write", async ({ records: factory }) => {
      const repository = factory.forTenant(scope);
      const visible = await repository.list();
      const foreign = await repository.find(tenantBRecord.id);
      const foreignWrites = await repository.rename(tenantBRecord.id, "compromised");
      const created = await repository.create("A three");
      return { visible, foreign, foreignWrites, created };
    });

    expect(result.visible.map(({ title }) => title)).toEqual(["A one", "A two"]);
    expect(result.foreign).toBeNull();
    expect(result.foreignWrites).toBe(0);
    expect(result.created).toMatchObject({ tenantId: "tenant-a", title: "A three" });
    expect(await context.db.select().from(records).where(eq(records.id, tenantBRecord.id))).toEqual(
      [expect.objectContaining({ tenantId: "tenant-b", title: "B one" })],
    );
  });

  it("requires separately issued bypass evidence and audits privileged repository use", async () => {
    const seeded = await seed();
    const tenantBRecord = seeded.find(({ tenantId }) => tenantId === "tenant-b")!;
    const authority = createTenantBypassAuthority({
      id: "platform.tenant-bypass",
      audit: (event) => events.push(event),
    });
    const bypass = authority.issue({
      requestId: "support-1",
      actor: operationActor({ id: "operator-1" }),
      reason: "correct tenant-b title after support approval",
    });

    const visible = await unitOfWork().run("write", async ({ records: factory }) => {
      const repository = factory.withBypass(bypass);
      expect(await repository.rename("tenant-b", tenantBRecord.id, "B repaired")).toBe(1);
      return repository.listEveryTenant();
    });

    expect(visible.map(({ tenantId, title }) => ({ tenantId, title }))).toEqual([
      { tenantId: "tenant-a", title: "A one" },
      { tenantId: "tenant-a", title: "A two" },
      { tenantId: "tenant-b", title: "B repaired" },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        action: "issued",
        authorityId: "platform.tenant-bypass",
        requestId: "support-1",
        actorId: "operator-1",
      }),
      expect.objectContaining({
        action: "repository-accessed",
        repositoryId: "records.repository",
        requestId: "support-1",
      }),
    ]);
  });

  it("does not construct privileged access when repository-use audit fails", async () => {
    await seed();
    let fail = false;
    const authority = createTenantBypassAuthority({
      id: "platform.tenant-bypass",
      audit: () => {
        if (fail) throw new Error("audit unavailable");
      },
    });
    const bypass = authority.issue({
      requestId: "support-2",
      actor: operationActor({ id: "operator-2" }),
      reason: "inspect data for incident response",
    });
    fail = true;

    await expect(
      unitOfWork().run("read", ({ records: factory }) => factory.withBypass(bypass)),
    ).rejects.toMatchObject({
      code: "SHIP_TENANT_BYPASS_AUDIT_FAILED",
      repositoryId: "records.repository",
      cause: expect.objectContaining({ message: "audit unavailable" }),
    });
  });
});
