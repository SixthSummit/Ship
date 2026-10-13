import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  idempotencyStoreDependency,
  operationError,
  operationFailure,
  publicAccess,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDrizzleIdempotencyStore, shipIdempotencyTable } from "./idempotency.js";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const records = pgTable("idempotency_domain_records", {
  id: serial("id").primaryKey(),
  value: text("value").notNull(),
});
const keys = shipIdempotencyTable();
const schema = { records, keys };
type Schema = typeof schema;

interface Capabilities {
  readonly domain: { insert(value: string): Promise<void> };
}

const transactionToken = unitOfWorkDependency<Capabilities>("database.integration");
const storeToken = idempotencyStoreDependency("platform.idempotency");
const rejected = operationError({ code: "REJECTED", status: 422, message: "Rejected" });

describe("Drizzle idempotency store integration", () => {
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

  it("lets exactly one racing process claim a key, then replays the completed result", async () => {
    const processA = createDrizzleIdempotencyStore({
      database: drizzle(context.pool, { schema }),
      table: keys,
    });
    const processB = createDrizzleIdempotencyStore({
      database: drizzle(context.pool, { schema }),
      table: keys,
    });
    const now = new Date();

    const [first, second] = await Promise.all([
      processA.claim("orders:1", 60_000, { now }),
      processB.claim("orders:1", 60_000, { now }),
    ]);
    expect([first, second].sort()).toEqual(["claimed", "in-flight"]);

    await processA.complete("orders:1", { status: 200, data: { ok: true } }, { now });
    await expect(processB.claim("orders:1", 60_000, { now })).resolves.toBe("duplicate");
    await expect(processB.readResult("orders:1", { now })).resolves.toEqual({
      status: 200,
      data: { ok: true },
    });
  });

  it("replays an undefined body through JSONB without running the operation twice", async () => {
    const store = createDrizzleIdempotencyStore({ database: context.db, table: keys });
    const handler = vi.fn(() => undefined);
    const operation = defineOperation({
      id: "orders.acknowledge",
      input: { body: z.object({ key: z.string() }) },
      output: { 200: z.undefined() },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: {},
      idempotency: { key: (input) => input.body.key, windowMs: 60_000, store: storeToken },
      handler,
    });
    const executor = createExecutor(
      defineApp({
        id: "idempotency-empty-integration",
        modules: [
          defineModule({
            id: "orders",
            operations: [operation],
            providers: [valueProvider(storeToken, store)],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    const first = await executor.run("orders.acknowledge", { body: { key: "empty" } });
    const replay = await executor.run("orders.acknowledge", { body: { key: "empty" } });
    expect(first).toMatchObject({ ok: true, status: 200, data: undefined });
    expect(replay).toMatchObject({ ok: true, status: 200, data: undefined, replayed: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await context.db.select().from(keys)).toMatchObject([
      { status: "completed", result: { status: 200, data: null, dataUndefined: true } },
    ]);
  });

  it("allows a re-run after the window expires and after an explicit release", async () => {
    const store = createDrizzleIdempotencyStore({ database: context.db, table: keys });
    const now = new Date();

    await expect(store.claim("k", 1_000, { now })).resolves.toBe("claimed");
    await store.complete("k", { status: 200, data: 1 }, { now });
    const later = new Date(now.getTime() + 1_001);
    await expect(store.readResult("k", { now: later })).resolves.toBeUndefined();
    await expect(store.claim("k", 1_000, { now: later })).resolves.toBe("claimed");
    await expect(store.readResult("k", { now: later })).resolves.toBeUndefined();

    await store.release("k", { now: later });
    await expect(store.claim("k", 1_000, { now: later })).resolves.toBe("claimed");
    await store.complete("k", { status: 200, data: 2 }, { now: later });
    await store.release("k", { now: later });
    await expect(store.claim("k", 1_000, { now: later })).resolves.toBe("duplicate");
  });

  it("joins the write transaction so the claim rolls back with a failed handler", async () => {
    const store = createDrizzleIdempotencyStore({ database: context.db, table: keys });
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.integration",
      database: context.db,
      create: (transaction: DrizzleTransaction<Schema>) => ({
        domain: {
          insert: async (value: string) => {
            await transaction.insert(records).values({ value });
          },
        },
      }),
    });
    const handler = vi.fn(
      async ({
        input,
        services,
      }: {
        readonly input: { readonly body: { readonly key: string; readonly fail?: boolean } };
        readonly services: { readonly tx: Capabilities };
      }) => {
        await services.tx.domain.insert(input.body.key);
        if (input.body.fail) throw operationFailure(rejected);
        return { stored: input.body.key };
      },
    );
    const operation = defineOperation({
      id: "orders.place",
      input: { body: z.object({ key: z.string(), fail: z.boolean().optional() }) },
      output: { 200: z.object({ stored: z.string() }) },
      successStatus: 200,
      errors: [rejected],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      idempotency: { key: (input) => input.body.key, windowMs: 60_000, store: storeToken },
      handler: handler as never,
    });
    const executor = createExecutor(
      defineApp({
        id: "idempotency-integration",
        modules: [
          defineModule({
            id: "orders",
            operations: [operation],
            providers: [
              valueProvider(transactionToken, unitOfWork),
              valueProvider(storeToken, store),
            ],
            imports: [],
            exports: [],
          }),
        ],
      }),
    );

    await expect(
      executor.run("orders.place", { body: { key: "o1", fail: true } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "REJECTED" } });
    expect(await context.db.select().from(keys)).toHaveLength(0);
    expect(await context.db.select().from(records)).toHaveLength(0);

    await expect(executor.run("orders.place", { body: { key: "o1" } })).resolves.toMatchObject({
      ok: true,
      data: { stored: "o1" },
    });
    await expect(executor.run("orders.place", { body: { key: "o1" } })).resolves.toMatchObject({
      ok: true,
      data: { stored: "o1" },
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await context.db.select().from(records)).toHaveLength(1);
    expect(await context.db.select().from(keys)).toMatchObject([
      { key: "orders.place:o1", status: "completed" },
    ]);
  });
});
