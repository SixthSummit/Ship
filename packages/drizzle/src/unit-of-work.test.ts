import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  classifyPostgresTransactionFailure,
  createDrizzleUnitOfWork,
  DrizzleUnitOfWorkError,
  transactionForScope,
} from "./unit-of-work.js";

interface FakeTransaction {
  readonly id: number;
}

function fakeDatabase() {
  const state = {
    transactions: 0,
    configs: [] as unknown[],
  };
  const database = {
    async transaction<TResult>(
      work: (transaction: FakeTransaction) => Promise<TResult>,
      config: unknown,
    ): Promise<TResult> {
      state.transactions += 1;
      state.configs.push(config);
      return work(Object.freeze({ id: state.transactions }));
    },
  };
  return {
    database: database as unknown as NodePgDatabase<Record<string, never>>,
    state,
  };
}

describe("createDrizzleUnitOfWork", () => {
  it.each([
    ["read", { accessMode: "read only" }],
    ["write", { accessMode: "read write" }],
  ] as const)("opens one %s transaction and returns work output", async (mode, config) => {
    const { database, state } = fakeDatabase();
    const create = vi.fn((transaction: FakeTransaction) => ({ repository: { transaction } }));
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: create as never,
    });

    const result = await unitOfWork.run(mode, ({ repository }) => repository.transaction.id);

    expect(result).toBe(1);
    expect(state.transactions).toBe(1);
    expect(state.configs).toEqual([config]);
    expect(create).toHaveBeenCalledOnce();
    expect(unitOfWork).toMatchObject({
      kind: "ship.unit-of-work",
      adapter: "drizzle",
      id: "database.primary",
      nested: "join",
    });
    expect(Object.isFrozen(unitOfWork)).toBe(true);
  });

  it("exposes one frozen capability map instead of the base database", async () => {
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ repository: { transaction } }),
    });

    await unitOfWork.run("write", (capabilities) => {
      expect(Object.keys(capabilities)).toEqual(["repository"]);
      expect(Reflect.has(capabilities, "database")).toBe(false);
      expect(Object.isFrozen(capabilities)).toBe(true);
    });
  });

  it("joins nested calls to the same transaction and capabilities", async () => {
    const { database, state } = fakeDatabase();
    const create = vi.fn((transaction: FakeTransaction) => ({ repository: { transaction } }));
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: create as never,
    });

    await unitOfWork.run("write", async (outer) => {
      await unitOfWork.run("read", async (innerRead) => {
        expect(innerRead).toBe(outer);
        await unitOfWork.run("write", (innerWrite) => expect(innerWrite).toBe(outer));
      });
    });

    expect(state.transactions).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects write escalation inside a read-only transaction", async () => {
    const { database, state } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ repository: { transaction } }),
    });

    await expect(
      unitOfWork.run("read", () => unitOfWork.run("write", () => undefined)),
    ).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_TRANSACTION_MODE_ESCALATION",
      unitOfWorkId: "database.primary",
    });
    expect(state.transactions).toBe(1);
  });

  it("can reject all nested calls by explicit policy", async () => {
    const { database, state } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      nested: "reject",
      create: (transaction) => ({ repository: { transaction } }),
    });

    await expect(
      unitOfWork.run("write", () => unitOfWork.run("read", () => undefined)),
    ).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_NESTED_TRANSACTION_REJECTED",
      unitOfWorkId: "database.primary",
    });
    expect(state.transactions).toBe(1);
  });

  it("isolates concurrent root transactions while preserving their nested scope", async () => {
    const { database, state } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ transaction }),
    });

    const runs = await Promise.all(
      [1, 2].map(() =>
        unitOfWork.run("write", async (outer) => {
          await Promise.resolve();
          return unitOfWork.run("read", (inner) => [outer.transaction, inner.transaction] as const);
        }),
      ),
    );

    expect(state.transactions).toBe(2);
    expect(runs[0]?.[0]).toBe(runs[0]?.[1]);
    expect(runs[1]?.[0]).toBe(runs[1]?.[1]);
    expect(runs[0]?.[0]).not.toBe(runs[1]?.[0]);
  });

  it("propagates transaction and work failures without replacing them", async () => {
    const failure = new Error("rollback this transaction");
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ repository: { transaction } }),
    });

    await expect(
      unitOfWork.run("write", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("marks a joined transaction rollback-only when nested failure is caught", async () => {
    const failure = new Error("nested write failed");
    const laterFailure = new Error("later nested write failed");
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ repository: { transaction } }),
    });

    await expect(
      unitOfWork.run("write", async () => {
        try {
          await unitOfWork.run("write", () => {
            throw failure;
          });
        } catch {
          // A joined failure cannot be converted into a partial outer commit.
        }
        try {
          await unitOfWork.run("write", () => {
            throw laterFailure;
          });
        } catch {
          // The first failure remains the reason the root transaction aborts.
        }
        return "must not commit";
      }),
    ).rejects.toBe(failure);
  });

  it.each([
    [null, "unit-of-work definition must be an object"],
    [{}, "unit-of-work id"],
    [{ id: "Bad ID" }, "unit-of-work id"],
    [{ id: "database.primary", database: {} }, "database must provide transaction"],
    [
      { id: "database.primary", database: { transaction() {} }, create: null },
      "create must be a function",
    ],
    [
      {
        id: "database.primary",
        database: { transaction() {} },
        create() {},
        nested: "savepoint",
      },
      "nested policy",
    ],
  ])("rejects invalid definition %#", (definition, message) => {
    const create = createDrizzleUnitOfWork as (definition: unknown) => unknown;

    try {
      create(definition);
      expect.fail("expected an invalid unit-of-work definition");
    } catch (error) {
      expect(error).toBeInstanceOf(DrizzleUnitOfWorkError);
      expect((error as Error).message).toContain(message);
    }
  });

  it.each([
    ["snapshot", () => undefined, "SHIP_DRIZZLE_UNIT_OF_WORK_MODE_INVALID"],
    ["read", null, "SHIP_DRIZZLE_UNIT_OF_WORK_WORK_INVALID"],
  ])("rejects invalid run arguments %#", async (mode, work, code) => {
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (transaction) => ({ repository: { transaction } }),
    });
    const run = unitOfWork.run as (mode: unknown, work: unknown) => Promise<unknown>;

    await expect(run(mode, work)).rejects.toMatchObject({ code });
  });

  it.each([
    [null, undefined],
    [[], undefined],
    [Promise.resolve({ repository: {} }), undefined],
    [{ BadName: {} }, "BadName"],
    [{ repository: undefined }, "repository"],
  ])("rejects invalid capability map %#", async (capabilities, capability) => {
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: (() => capabilities) as never,
    });

    await expect(unitOfWork.run("write", () => undefined)).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_UNIT_OF_WORK_CAPABILITIES_INVALID",
      ...(capability ? { capability } : {}),
    });
  });
});

describe("transaction isolation", () => {
  function unitOfWork() {
    const fake = fakeDatabase();
    return {
      ...fake,
      unitOfWork: createDrizzleUnitOfWork({
        id: "database.primary",
        database: fake.database,
        create: (transaction) => ({ repository: { transaction } }),
      }),
    };
  }

  it.each([
    "read committed",
    "repeatable read",
    "serializable",
  ] as const)("sets %s on the outermost transaction together with the access mode", async (isolation) => {
    const { unitOfWork: work, state } = unitOfWork();

    await work.run("write", () => undefined, { isolation });

    expect(state.configs).toEqual([{ accessMode: "read write", isolationLevel: isolation }]);
  });

  it("leaves the server default in place when no level is declared", async () => {
    const { unitOfWork: work, state } = unitOfWork();

    await work.run("read", () => undefined);
    await work.run("read", () => undefined, {});

    expect(state.configs).toEqual([{ accessMode: "read only" }, { accessMode: "read only" }]);
  });

  it("joins a nested run to the outer level instead of opening another transaction", async () => {
    const { unitOfWork: work, state } = unitOfWork();

    await work.run(
      "write",
      (outer) =>
        work.run("write", (inner) => expect(inner).toBe(outer), { isolation: "read committed" }),
      { isolation: "serializable" },
    );

    expect(state.configs).toEqual([{ accessMode: "read write", isolationLevel: "serializable" }]);
  });

  it("rejects an isolation level PostgreSQL does not offer before opening anything", async () => {
    const { unitOfWork: work, state } = unitOfWork();

    await expect(
      work.run("write", () => undefined, { isolation: "snapshot" as never }),
    ).rejects.toMatchObject({ code: "SHIP_DRIZZLE_UNIT_OF_WORK_ISOLATION_INVALID" });
    expect(state.transactions).toBe(0);
  });
});

describe("classifyPostgresTransactionFailure", () => {
  function sqlstate(code: string): Error {
    return Object.assign(new Error(`SQLSTATE ${code}`), { code });
  }

  it("classifies serialization failures and deadlocks by SQLSTATE", () => {
    expect(classifyPostgresTransactionFailure(sqlstate("40001"))).toBe("serialization");
    expect(classifyPostgresTransactionFailure(sqlstate("40P01"))).toBe("deadlock");
  });

  it("reads the SQLSTATE anywhere in the cause chain", () => {
    const wrapped = new Error("handler failed", {
      cause: new Error("Failed query", { cause: sqlstate("40001") }),
    });

    expect(classifyPostgresTransactionFailure(wrapped)).toBe("serialization");
    expect(unitOfWorkClassifier()(wrapped)).toBe("serialization");
  });

  it.each([
    ["another SQLSTATE", sqlstate("23505")],
    ["a numeric code", Object.assign(new Error("x"), { code: 40001 })],
    ["a plain error", new Error("connection reset")],
    ["a string", "40001"],
    ["undefined", undefined],
    ["a self-referencing cause chain", selfCaused()],
  ])("returns undefined for %s", (_name, error) => {
    expect(classifyPostgresTransactionFailure(error)).toBeUndefined();
  });

  function selfCaused(): Error {
    const error = new Error("loop");
    Object.defineProperty(error, "cause", { value: error });
    return error;
  }

  function unitOfWorkClassifier() {
    const { database } = fakeDatabase();
    return createDrizzleUnitOfWork({ id: "database.primary", database, create: () => ({}) })
      .classifyFailure;
  }
});

describe("transactionForScope", () => {
  it("resolves the transaction only for capability maps built by a Drizzle unit of work", async () => {
    const { database } = fakeDatabase();
    const unitOfWork = createDrizzleUnitOfWork({
      id: "database.primary",
      database,
      create: ((transaction: FakeTransaction) => ({ repository: { transaction } })) as never,
    });
    let captured: unknown;
    await unitOfWork.run("write", (capabilities) => {
      captured = capabilities;
      expect(transactionForScope(capabilities)).toEqual({ id: 1 });
      return undefined;
    });

    expect(transactionForScope({ ...(captured as object) })).toBeUndefined();
    expect(transactionForScope(undefined)).toBeUndefined();
    expect(transactionForScope("scope")).toBeUndefined();
  });
});
