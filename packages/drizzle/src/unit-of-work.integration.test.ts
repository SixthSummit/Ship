import {
  createExecutor,
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  publicAccess,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { type PostgresTestDb, setupPostgresTestDb, truncateAll } from "@sixthsummit/ship-testing";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

const domainWrites = pgTable("uow_domain_writes", {
  id: serial("id").primaryKey(),
  value: text("value").notNull(),
});

const auditWrites = pgTable("uow_audit_writes", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
});

const schema = { domainWrites, auditWrites };
type Schema = typeof schema;
type Transaction = DrizzleTransaction<Schema>;

interface TransactionCapabilities {
  readonly domain: DomainRepository;
  readonly audit: AuditRepository;
}

const transactionToken = unitOfWorkDependency<TransactionCapabilities>("database.integration");
const writeRejected = operationError({
  code: "WRITE_REJECTED",
  status: 409,
  message: "Write rejected",
});

class DomainRepository {
  constructor(private readonly transaction: Transaction) {}

  async insert(value: string): Promise<void> {
    await this.transaction.insert(domainWrites).values({ value });
  }
}

class AuditRepository {
  constructor(private readonly transaction: Transaction) {}

  async append(action: string): Promise<void> {
    await this.transaction.insert(auditWrites).values({ action });
  }
}

describe("Drizzle unit of work integration", () => {
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

  function unitOfWork(nested: "join" | "reject" = "join") {
    return createDrizzleUnitOfWork({
      id: "database.integration",
      database: context.db,
      nested,
      create: (transaction) => ({
        domain: new DomainRepository(transaction),
        audit: new AuditRepository(transaction),
      }),
    });
  }

  function executor(
    work: ReturnType<typeof unitOfWork>,
    handler: (arguments_: {
      readonly services: { readonly tx: TransactionCapabilities };
    }) => { readonly ok: true } | Promise<{ readonly ok: true }>,
  ) {
    const operation = defineOperation({
      id: "records.write",
      input: {},
      output: { 200: z.object({ ok: z.literal(true) }) },
      successStatus: 200,
      errors: [writeRejected],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      handler,
    });
    const module = defineModule({
      id: "records",
      operations: [operation],
      providers: [valueProvider(transactionToken, work)],
      imports: [],
      exports: [],
    });
    return createExecutor(defineApp({ id: "uow-integration", modules: [module] }));
  }

  it("rejects a detached continuation after its transaction completes", async () => {
    const work = unitOfWork();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<void>;
    await work.run("write", async ({ domain }) => {
      await domain.insert("committed");
      detached = pending.then(() => work.run("write", ({ domain }) => domain.insert("detached")));
    });
    const rejection = expect(detached).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_TRANSACTION_SCOPE_CLOSED",
    });
    release();
    await rejection;
    expect((await context.db.select().from(domainWrites)).map((row) => row.value)).toEqual([
      "committed",
    ]);
    // Calls originating outside the old async context still open fresh transactions.
    await work.run("write", ({ domain }) => domain.insert("fresh"));
    expect(await context.db.select().from(domainWrites)).toHaveLength(2);
  });

  it("rolls back writes when cancellation occurs in async output validation", async () => {
    const controller = new AbortController();
    const work = unitOfWork();
    const operation = defineOperation({
      id: "records.validate",
      input: {},
      output: {
        200: z.object({ ok: z.literal(true) }).transform(async (value) => {
          controller.abort();
          return value;
        }),
      },
      successStatus: 200,
      errors: [],
      access: publicAccess(),
      transaction: "write",
      dependencies: { tx: transactionToken },
      handler: async ({ services }) => {
        await services.tx.domain.insert("must-rollback");
        return { ok: true as const };
      },
    });
    const app = defineApp({
      id: "validation",
      modules: [
        defineModule({
          id: "records",
          operations: [operation],
          providers: [valueProvider(transactionToken, work)],
          imports: [],
          exports: [],
        }),
      ],
    });
    await expect(
      createExecutor(app).run("records.validate", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "SHIP_OPERATION_ABORTED" });
    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
  });

  it("commits domain and audit repositories from one transaction", async () => {
    const work = unitOfWork();
    const operationExecutor = executor(work, async ({ services }) => {
      await services.tx.domain.insert("account-1");
      await services.tx.audit.append("account.created");
      return { ok: true };
    });

    await expect(operationExecutor.run("records.write", {})).resolves.toMatchObject({ ok: true });

    expect(await context.db.select().from(domainWrites)).toHaveLength(1);
    expect(await context.db.select().from(auditWrites)).toHaveLength(1);
  });

  it("rolls back writes before normalizing a declared operation failure", async () => {
    const work = unitOfWork();
    const operationExecutor = executor(work, async ({ services }) => {
      await services.tx.domain.insert("account-1");
      await services.tx.audit.append("account.rejected");
      throw operationFailure(writeRejected);
    });

    await expect(operationExecutor.run("records.write", {})).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: { code: "WRITE_REJECTED" },
    });
    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
    expect(await context.db.select().from(auditWrites)).toHaveLength(0);
  });

  it.each([
    "after-domain",
    "after-audit",
    "after-nested-domain",
    "after-nested-audit",
    "after-nested-return",
  ])("rolls back every write when failure is injected %s", async (failurePoint) => {
    const work = unitOfWork();

    await expect(
      work.run("write", async ({ domain, audit }) => {
        await domain.insert("root-domain");
        inject(failurePoint, "after-domain");
        await audit.append("root.audit");
        inject(failurePoint, "after-audit");

        await work.run("write", async (nested) => {
          await nested.domain.insert("nested-domain");
          inject(failurePoint, "after-nested-domain");
          await nested.audit.append("nested.audit");
          inject(failurePoint, "after-nested-audit");
        });
        inject(failurePoint, "after-nested-return");
      }),
    ).rejects.toThrow(`injected ${failurePoint}`);

    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
    expect(await context.db.select().from(auditWrites)).toHaveLength(0);
  });

  it("has PostgreSQL enforce the read-only mode", async () => {
    const work = unitOfWork();

    await expect(
      work.run("read", ({ domain }) => domain.insert("not-allowed")),
    ).rejects.toMatchObject({ cause: { code: "25006" } });
    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
  });

  it("rejects a nested write request before it can escalate a read transaction", async () => {
    const work = unitOfWork();

    await expect(
      work.run("read", () => work.run("write", ({ domain }) => domain.insert("not-allowed"))),
    ).rejects.toMatchObject({ code: "SHIP_DRIZZLE_TRANSACTION_MODE_ESCALATION" });
    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
  });

  it("rolls back a joined failure even when outer work catches it", async () => {
    const failure = new Error("nested audit failed");
    const work = unitOfWork();

    await expect(
      work.run("write", async ({ domain }) => {
        await domain.insert("outer-domain");
        try {
          await work.run("write", async ({ audit }) => {
            await audit.append("nested.audit");
            throw failure;
          });
        } catch {
          // Joined work has already made this transaction rollback-only.
        }
        return "must not commit";
      }),
    ).rejects.toBe(failure);

    expect(await context.db.select().from(domainWrites)).toHaveLength(0);
    expect(await context.db.select().from(auditWrites)).toHaveLength(0);
  });
});

function inject(actual: string, expected: string): void {
  if (actual === expected) throw new Error(`injected ${actual}`);
}
