import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { and, asc, count, eq } from "drizzle-orm";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineAuditColumns, defineSoftDeleteColumns } from "./field-policies.js";
import { offsetPage, resolveOffsetPagination } from "./pagination.js";
import { defineRepositoryProjections, type RepositoryProjections } from "./projections.js";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const records = pgTable("repository_primitive_records", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  secret: text("secret").notNull(),
  createdDate: timestamp("createdDate", { withTimezone: true }).notNull(),
  updatedDate: timestamp("updatedDate", { withTimezone: true }).notNull(),
  deletedDate: timestamp("deletedDate", { withTimezone: true }),
  createdByUserId: text("createdByUserId"),
  updatedByUserId: text("updatedByUserId"),
});

const schema = { records };
type Schema = typeof schema;
type Transaction = DrizzleTransaction<Schema>;
type Summary = { readonly id: number; readonly title: string };
type Detail = Summary & { readonly secret: string };
type RecordProjectionDefinitions = {
  readonly summary: (id: number) => Promise<Summary | null>;
  readonly detail: (id: number) => Promise<Detail | null>;
};

const audit = defineAuditColumns(records, {
  createdAt: "createdDate",
  updatedAt: "updatedDate",
  createdBy: "createdByUserId",
  updatedBy: "updatedByUserId",
});
const softDelete = defineSoftDeleteColumns(records, {
  deletedAt: "deletedDate",
  updatedAt: "updatedDate",
  actor: "updatedByUserId",
});

class RecordsRepository {
  private readonly projections: RepositoryProjections<RecordProjectionDefinitions>;

  constructor(private readonly transaction: Transaction) {
    this.projections = defineRepositoryProjections({
      summary: async (id: number) => {
        const [row] = await this.transaction
          .select({ id: records.id, title: records.title })
          .from(records)
          .where(and(eq(records.id, id), softDelete.active()))
          .limit(1);
        return row ?? null;
      },
      detail: async (id: number) => {
        const [row] = await this.transaction
          .select({ id: records.id, title: records.title, secret: records.secret })
          .from(records)
          .where(and(eq(records.id, id), softDelete.active()))
          .limit(1);
        return row ?? null;
      },
    });
  }

  async create(title: string, secret: string, at: Date, actorId?: string) {
    const [row] = await this.transaction
      .insert(records)
      .values({
        title,
        secret,
        ...audit.created({ at, actorId }),
        ...audit.updated({ at, actorId }),
      })
      .returning();
    return row!;
  }

  summary(id: number) {
    return this.projections.run("summary", id);
  }

  detail(id: number) {
    return this.projections.run("detail", id);
  }

  async list(input: { readonly limit?: number; readonly offset?: number }) {
    const pagination = resolveOffsetPagination(input, { defaultLimit: 2, maxLimit: 3 });
    const active = softDelete.active();
    const items = await this.transaction
      .select({ id: records.id, title: records.title })
      .from(records)
      .where(active)
      .orderBy(asc(records.id))
      .limit(pagination.limit)
      .offset(pagination.offset);
    const totals = await this.transaction.select({ value: count() }).from(records).where(active);
    return offsetPage(items, totals[0]?.value ?? 0, pagination);
  }

  async remove(id: number, at: Date, actorId?: string): Promise<void> {
    await this.transaction
      .update(records)
      .set(softDelete.deletedValues({ at, actorId }))
      .where(and(eq(records.id, id), softDelete.active()));
  }

  async restore(id: number, at: Date, actorId?: string): Promise<void> {
    await this.transaction
      .update(records)
      .set(softDelete.restoredValues({ at, actorId }))
      .where(and(eq(records.id, id), softDelete.deleted()));
  }
}

describe("typed repository primitives integration", () => {
  let context: PostgresTestDb<Schema>;

  beforeAll(async () => {
    context = await setupPostgresTestDb(schema);
  });

  beforeEach(async () => {
    await truncateAll(context);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  function unitOfWork() {
    return createDrizzleUnitOfWork({
      id: "database.repository-primitives",
      database: context.db,
      create: (transaction) => ({ records: new RecordsRepository(transaction) }),
    });
  }

  it("uses configured audit names and returns only the selected named projection", async () => {
    const at = new Date("2026-09-03T14:00:00.000Z");
    const actorId = "actor-1";
    const result = await unitOfWork().run("write", async ({ records: repository }) => {
      const created = await repository.create("Visible", "classified", at, actorId);
      return {
        summary: await repository.summary(created.id),
        detail: await repository.detail(created.id),
      };
    });

    expect(result.summary).toEqual({ id: 1, title: "Visible" });
    expect(result.summary).not.toHaveProperty("secret");
    expect(result.detail).toEqual({ id: 1, title: "Visible", secret: "classified" });
    expect(await context.db.select().from(records)).toEqual([
      expect.objectContaining({
        createdDate: at,
        updatedDate: at,
        createdByUserId: actorId,
        updatedByUserId: actorId,
      }),
    ]);
  });

  it("keeps active-row pagination and its matching count in agreement", async () => {
    const at = new Date("2026-09-03T15:00:00.000Z");
    const result = await unitOfWork().run("write", async ({ records: repository }) => {
      const created: Awaited<ReturnType<RecordsRepository["create"]>>[] = [];
      for (const title of ["one", "two", "three", "four"]) {
        created.push(await repository.create(title, `${title}-secret`, at));
      }
      await repository.remove(created[1]!.id, at, "actor-delete");
      const first = await repository.list({ limit: 2, offset: 0 });
      const second = await repository.list({ limit: 2, offset: 1 });
      await repository.restore(created[1]!.id, at, "actor-restore");
      const restored = await repository.list({ limit: 3, offset: 0 });
      return { first, second, restored };
    });

    expect(result.first).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
    expect(result.first.items.map(({ title }) => title)).toEqual(["one", "three"]);
    expect(result.second).toMatchObject({ total: 3, limit: 2, offset: 1, hasMore: false });
    expect(result.second.items.map(({ title }) => title)).toEqual(["three", "four"]);
    expect(result.restored).toMatchObject({ total: 4, hasMore: true });
  });

  it("inherits the transaction so repository writes cannot escape rollback", async () => {
    const at = new Date("2026-09-03T16:00:00.000Z");
    const [seed] = await context.db
      .insert(records)
      .values({
        title: "seed",
        secret: "seed-secret",
        ...audit.created({ at, actorId: "seed-actor" }),
        ...audit.updated({ at, actorId: "seed-actor" }),
      })
      .returning();

    await expect(
      unitOfWork().run("write", async ({ records: repository }) => {
        await repository.create("transient", "transient-secret", at);
        await repository.remove(seed!.id, at, "rollback-actor");
        throw new Error("rollback repository changes");
      }),
    ).rejects.toThrow("rollback repository changes");

    expect(await context.db.select().from(records)).toEqual([
      expect.objectContaining({ id: seed!.id, title: "seed", deletedDate: null }),
    ]);
  });
});
