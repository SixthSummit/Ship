import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertMigrationsApplied, migrationsStatus, PendingMigrationsError } from "./boot-guard.js";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "migrations",
  "safe",
);

function ledger(latest: number | undefined | "missing") {
  return {
    query: async () => {
      if (latest === "missing") {
        const error = new Error(
          'relation "drizzle.__drizzle_migrations" does not exist',
        ) as Error & { code: string };
        error.code = "42P01";
        throw error;
      }
      return { rows: latest === undefined ? [] : [{ created_at: String(latest) }] };
    },
  };
}

describe("migrations boot guard", () => {
  it("reports every journal entry pending when the ledger table is missing or empty", async () => {
    expect(await migrationsStatus({ client: ledger("missing"), migrationsDir })).toEqual({
      applied: 0,
      pending: ["0000_init", "0001_add_currency"],
    });
    expect(await migrationsStatus({ client: ledger(undefined), migrationsDir })).toEqual({
      applied: 0,
      pending: ["0000_init", "0001_add_currency"],
    });
  });

  it("uses the migrator's rule: entries newer than the latest ledger row are pending", async () => {
    expect(await migrationsStatus({ client: ledger(1760000000000), migrationsDir })).toEqual({
      applied: 1,
      pending: ["0001_add_currency"],
    });
    expect(await assertMigrationsApplied({ client: ledger(1760000100000), migrationsDir })).toEqual(
      {
        applied: 2,
        pending: [],
      },
    );
  });

  it("throws PendingMigrationsError instead of applying anything", async () => {
    await expect(
      assertMigrationsApplied({ client: ledger(1760000000000), migrationsDir }),
    ).rejects.toThrow(PendingMigrationsError);
    await expect(
      assertMigrationsApplied({ client: ledger(1760000000000), migrationsDir }),
    ).rejects.toThrow(/never at boot/u);
  });

  it("re-throws unrelated database errors", async () => {
    const client = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    await expect(migrationsStatus({ client, migrationsDir })).rejects.toThrow("connection refused");
  });
});
