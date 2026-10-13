import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advisoryLockKey, advisoryLockProvider } from "./advisory-lock.js";
import { DrizzleRepositoryError } from "./repository-error.js";

/** A fake database whose transactions run the callback against a scripted `execute`. */
function fakeDatabase(acquired: () => boolean, shape: "rows" | "array" = "rows") {
  const open: string[] = [];
  const commits: string[] = [];
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      open.push("begin");
      const tx = {
        execute: async () =>
          shape === "rows" ? { rows: [{ acquired: acquired() }] } : [{ acquired: acquired() }],
      };
      try {
        return await callback(tx);
      } finally {
        commits.push("commit");
      }
    },
  };
  return { database: database as never, open, commits };
}

describe("advisoryLockProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the transaction open until release and reports the lease", async () => {
    const db = fakeDatabase(() => true);
    const provider = advisoryLockProvider(db.database, { clock: () => new Date(0) });
    const lease = await provider.acquire("reports.digest", "acme", 1_000);

    expect(lease).toMatchObject({
      jobId: "reports.digest",
      key: "acme",
      expiresAt: new Date(1_000),
    });
    expect(provider.held()).toBe(1);
    expect(db.commits).toEqual([]);

    await provider.release(lease as never);
    await vi.runAllTimersAsync();
    expect(db.commits).toEqual(["commit"]);
    expect(provider.held()).toBe(0);
    await expect(provider.release(lease as never)).resolves.toBeUndefined();
  });

  it("returns undefined and ends the transaction when the lock is taken", async () => {
    const db = fakeDatabase(() => false, "array");
    const provider = advisoryLockProvider(db.database);
    await expect(provider.acquire("reports.digest", "acme", 1_000)).resolves.toBeUndefined();
    expect(db.commits).toEqual(["commit"]);
    expect(provider.held()).toBe(0);
  });

  it("releases automatically when the lease expires unless extended", async () => {
    const db = fakeDatabase(() => true);
    let now = 0;
    const provider = advisoryLockProvider(db.database, { clock: () => new Date(now) });
    const lease = await provider.acquire("reports.digest", "acme", 1_000);

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    expect(await provider.extend(lease as never, 1_000)).toBe(true);
    now = 1_200;
    await vi.advanceTimersByTimeAsync(700);
    expect(db.commits).toEqual([]);
    now = 1_600;
    await vi.advanceTimersByTimeAsync(400);
    expect(db.commits).toEqual(["commit"]);
    expect(await provider.extend(lease as never, 1_000)).toBe(false);
    expect(provider.held()).toBe(0);
  });

  it("surfaces transaction failures and validates arguments", async () => {
    const failing = {
      transaction: async () => {
        throw new Error("connection refused");
      },
    };
    const provider = advisoryLockProvider(failing as never);
    await expect(provider.acquire("reports.digest", "acme", 1_000)).rejects.toThrow(
      "connection refused",
    );
    await expect(provider.acquire("", "acme", 1_000)).rejects.toBeInstanceOf(
      DrizzleRepositoryError,
    );
    await expect(provider.acquire("reports.digest", "acme", 0)).rejects.toMatchObject({
      code: "SHIP_DRIZZLE_LOCK_INVALID",
    });
    expect(() => advisoryLockProvider({} as never)).toThrow(DrizzleRepositoryError);
  });

  it("derives a stable signed 64-bit key from keyspace, job and key", () => {
    const key = advisoryLockKey("ship.jobs", "reports.digest", "acme");
    expect(typeof key).toBe("bigint");
    expect(key).toBe(advisoryLockKey("ship.jobs", "reports.digest", "acme"));
    expect(key).not.toBe(advisoryLockKey("ship.jobs", "reports.digest", "beta"));
    expect(key).not.toBe(advisoryLockKey("other", "reports.digest", "acme"));
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});
