import { TransactionRollbackError } from "drizzle-orm/errors";
import { describe, expect, it, vi } from "vitest";
import { getRequestContext, runWithRequestContext } from "../context/RequestContext.js";
import { RollbackError, type ShipTx, withTransaction } from "./transaction.js";

/**
 * Unit tests for the `withTransaction` wrapper. We feed it a stand-in `db`
 * whose `.transaction(fn)` mirrors Drizzle's contract closely enough to
 * exercise the retry / rollback / context-propagation logic. Real-DB
 * integration is covered later via testcontainers in
 * `DrizzleEntityService` integration tests.
 */
function makeFakeDb(
  opts: {
    failuresBeforeSuccess?: Array<{ code?: string; message?: string }>;
    rollbackOnAttempt?: number;
  } = {},
) {
  const failures = [...(opts.failuresBeforeSuccess ?? [])];
  const state = { attempts: 0 };

  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      state.attempts += 1;
      if (failures.length > 0) {
        const f = failures.shift()!;
        const err = new Error(f.message ?? "fail");
        if (f.code) (err as { code?: string }).code = f.code;
        throw err;
      }
      if (opts.rollbackOnAttempt && opts.rollbackOnAttempt === state.attempts) {
        // Simulate Drizzle's tx.rollback() path
        throw new TransactionRollbackError();
      }
      return fn({ __fake: "tx" });
    },
  };

  return {
    db: db as unknown as Parameters<typeof withTransaction>[0],
    state,
  };
}

describe("withTransaction", () => {
  it("returns the callback's resolved value on first-attempt success", async () => {
    const { db, state } = makeFakeDb();
    const result = await withTransaction(db, async () => "ok");
    expect(result).toBe("ok");
    expect(state.attempts).toBe(1);
  });

  it("re-throws non-retryable errors verbatim", async () => {
    const { db } = makeFakeDb({ failuresBeforeSuccess: [{ message: "boom" }] });
    await expect(withTransaction(db, async () => "x")).rejects.toThrow("boom");
  });

  it("retries on Postgres serialization failure (40001) when retry is enabled", async () => {
    const { db, state } = makeFakeDb({
      failuresBeforeSuccess: [{ code: "40001" }, { code: "40001" }],
    });
    const result = await withTransaction(db, async () => "after-retry", {
      retryOnConflict: { attempts: 3, backoffMs: 0 },
    });
    expect(result).toBe("after-retry");
    expect(state.attempts).toBe(3);
  });

  it("retries on deadlock_detected (40P01) when retry is enabled", async () => {
    const { db, state } = makeFakeDb({
      failuresBeforeSuccess: [{ code: "40P01" }],
    });
    await withTransaction(db, async () => "ok", { retryOnConflict: { attempts: 2, backoffMs: 0 } });
    expect(state.attempts).toBe(2);
  });

  it("does not retry when retryOnConflict is unset (default)", async () => {
    const { db, state } = makeFakeDb({
      failuresBeforeSuccess: [{ code: "40001" }],
    });
    await expect(withTransaction(db, async () => "x")).rejects.toMatchObject({ code: "40001" });
    expect(state.attempts).toBe(1);
  });

  it("gives up after exhausting attempts and re-throws the last error", async () => {
    const { db, state } = makeFakeDb({
      failuresBeforeSuccess: [{ code: "40001" }, { code: "40001" }, { code: "40001" }],
    });
    await expect(
      withTransaction(db, async () => "x", { retryOnConflict: { attempts: 2, backoffMs: 0 } }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(state.attempts).toBe(2);
  });

  it("translates Drizzle TransactionRollbackError into RollbackError", async () => {
    const { db } = makeFakeDb({ rollbackOnAttempt: 1 });
    await expect(withTransaction(db, async () => "x")).rejects.toBeInstanceOf(RollbackError);
  });

  it("RollbackError preserves the underlying TransactionRollbackError as cause", async () => {
    const { db } = makeFakeDb({ rollbackOnAttempt: 1 });
    try {
      await withTransaction(db, async () => "x");
      expect.fail("expected RollbackError");
    } catch (err) {
      expect(err).toBeInstanceOf(RollbackError);
      expect((err as RollbackError).cause).toBeInstanceOf(TransactionRollbackError);
    }
  });

  it("does NOT retry on rollback even when retry is enabled", async () => {
    const { db, state } = makeFakeDb({ rollbackOnAttempt: 1 });
    await expect(
      withTransaction(db, async () => "x", { retryOnConflict: { attempts: 5, backoffMs: 0 } }),
    ).rejects.toBeInstanceOf(RollbackError);
    expect(state.attempts).toBe(1);
  });

  it("propagates the active tx into RequestContext during the callback", async () => {
    const { db } = makeFakeDb();
    let observedTx: unknown;
    let observedAfter: unknown;

    await runWithRequestContext({}, async () => {
      await withTransaction(db, async (tx) => {
        observedTx = getRequestContext()?.tx;
        // The fake db.transaction() passes the same fake tx object to the
        // wrapper, which the wrapper forwards to RequestContext.
        return tx;
      });
      observedAfter = getRequestContext()?.tx;
    });

    expect(observedTx).toEqual({ __fake: "tx" });
    expect(observedAfter).toBeUndefined();
  });

  it("does not throw if there is no active RequestContext (set is a no-op)", async () => {
    const { db } = makeFakeDb();
    await expect(withTransaction(db, async () => "ok")).resolves.toBe("ok");
  });

  it("forwards the tx argument to the callback", async () => {
    const { db } = makeFakeDb();
    const fn = vi.fn(async (_tx: ShipTx<Record<string, never>>) => "done");
    // ShipTx is too generic for our fake db's untyped tx; cast at the use site.
    await withTransaction(db, fn as unknown as (tx: unknown) => Promise<string>);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]?.[0]).toEqual({ __fake: "tx" });
  });
});
