import {
  cacheBackendDependency,
  cacheInvalidationOutbox,
  createExecutor,
  defineApp,
  defineCacheInvalidationModule,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
  systemActor,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import {
  createInMemoryCacheBackend,
  type InMemoryCacheBackend,
} from "@sixthsummit/ship-testing/cache";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrizzleOutbox, shipOutboxTable } from "./outbox.js";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const records = pgTable("cache_invalidation_records", {
  id: serial("id").primaryKey(),
  value: text("value").notNull(),
});
const outboxTable = shipOutboxTable();
const schema = { records, outboxTable };
type Schema = typeof schema;

interface Capabilities {
  readonly domain: { insert(value: string): Promise<void> };
}

const transactionToken = unitOfWorkDependency<Capabilities>("database.integration");
const cacheToken = cacheBackendDependency("platform.cache");
const writeRejected = operationError({ code: "WRITE_REJECTED", status: 409, message: "Rejected" });

/**
 * Declared invalidation against a real PostgreSQL unit of work.
 *
 * The purge intent is a row written by the same transaction as the business
 * change, so commit and rollback decide whether it exists at all — and nothing
 * is purged until a separate dispatcher run performs it. That makes
 * invalidation durable across a crash and eventual by construction.
 */
describe("declared cache invalidation integration", () => {
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
  }

  /** One application instance. Building a second one models a process restart. */
  function application(cache: InMemoryCacheBackend) {
    const read = defineOperation({
      id: "widgets.list",
      input: {},
      output: { 200: z.object({ total: z.number() }) },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "none",
      dependencies: { cache: cacheToken },
      cache: { ttlMs: 600_000, scope: "public", tags: ["widgets"] },
      handler: () => ({ total: 1 }),
    });
    const write = defineOperation({
      id: "widgets.rename",
      input: { body: z.object({ value: z.string(), fail: z.boolean().optional() }) },
      output: { 200: z.object({ renamed: z.literal(true) }) },
      successStatus: 200,
      errors: [writeRejected],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      invalidates: ["widgets"],
      handler: async ({ input, services }) => {
        await services.tx.domain.insert(input.body.value);
        if (input.body.fail) throw operationFailure(writeRejected);
        return { renamed: true as const };
      },
    });
    const widgets = defineModule({
      id: "widgets",
      operations: [read, write],
      providers: [valueProvider(cacheToken, cache), valueProvider(transactionToken, unitOfWork())],
      imports: ["ship-cache"],
      exports: [],
    });
    const invalidation = defineCacheInvalidationModule({
      cache,
      outbox: createDrizzleOutbox({
        outbox: cacheInvalidationOutbox,
        database: context.db,
        table: outboxTable,
      }),
    });
    return createExecutor(defineApp({ id: "cache-integration", modules: [widgets, invalidation] }));
  }

  const system = { actor: systemActor({ id: "dispatcher" }) };

  it("commits the purge intent with the write and purges only once dispatched", async () => {
    const cache = createInMemoryCacheBackend();
    const executor = application(cache);

    const miss = await executor.run("widgets.list", {});
    expect(miss).toMatchObject({ ok: true, cache: "miss" });
    expect(await executor.run("widgets.list", {})).toMatchObject({ cache: "hit" });

    const written = await executor.run("widgets.rename", { body: { value: "renamed" } });
    expect(written).toMatchObject({ ok: true });
    expect(await context.db.select().from(records)).toHaveLength(1);
    expect(await context.db.select().from(outboxTable)).toMatchObject([
      {
        outboxId: "ship-cache.invalidation",
        intentId: "purge-tag",
        status: "pending",
        payload: { tag: "widgets" },
      },
    ]);
    // Eventual by construction: between commit and dispatch the read still hits.
    expect(cache.size()).toBe(1);
    expect(await executor.run("widgets.list", {})).toMatchObject({ cache: "hit" });

    const dispatched = await executor.run("ship-cache.invalidation.dispatch", {}, system);
    expect(dispatched).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(cache.size()).toBe(0);
    expect(await executor.run("widgets.list", {})).toMatchObject({ cache: "miss" });
  });

  it("leaves no purge intent when the write rolls back", async () => {
    const cache = createInMemoryCacheBackend();
    const executor = application(cache);
    await executor.run("widgets.list", {});

    await expect(
      executor.run("widgets.rename", { body: { value: "lost", fail: true } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "WRITE_REJECTED" } });

    expect(await context.db.select().from(records)).toHaveLength(0);
    expect(await context.db.select().from(outboxTable)).toHaveLength(0);
    expect(await executor.run("widgets.list", {})).toMatchObject({ cache: "hit" });
    expect(await executor.run("ship-cache.invalidation.dispatch", {}, system)).toMatchObject({
      data: { claimed: 0 },
    });
  });

  it("recovers a committed purge when the process dies before dispatching", async () => {
    const firstCache = createInMemoryCacheBackend();
    const first = application(firstCache);
    await first.run("widgets.list", {});
    await first.run("widgets.rename", { body: { value: "renamed" } });
    expect(await context.db.select().from(outboxTable)).toHaveLength(1);

    // The process dies here: the cache instance and the executor are gone, the
    // intent row is not. A replacement process re-warms the cache and picks up
    // the pending purge.
    const secondCache = createInMemoryCacheBackend();
    const second = application(secondCache);
    await second.run("widgets.list", {});
    expect(secondCache.size()).toBe(1);

    const dispatched = await second.run("ship-cache.invalidation.dispatch", {}, system);
    expect(dispatched).toMatchObject({ ok: true, data: { claimed: 1, completed: 1 } });
    expect(secondCache.size()).toBe(0);
    expect(await context.db.select().from(outboxTable)).toMatchObject([{ status: "completed" }]);
  });

  it("records one intent per declared tag and dispatches them independently", async () => {
    const cache = createInMemoryCacheBackend();
    const executor = application(cache);
    await executor.run("widgets.rename", { body: { value: "a" } });
    await executor.run("widgets.rename", { body: { value: "b" } });
    expect(await context.db.select().from(outboxTable)).toHaveLength(2);

    const dispatched = await executor.run("ship-cache.invalidation.dispatch", {}, system);
    expect(dispatched).toMatchObject({ data: { claimed: 2, completed: 2 } });
  });
});
