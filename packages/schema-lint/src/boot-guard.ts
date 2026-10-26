import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SnapshotQueryable } from "./snapshot.js";

export interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

export async function readMigrationJournal(
  migrationsDir: string,
): Promise<readonly JournalEntry[]> {
  const path = resolve(migrationsDir, "meta", "_journal.json");
  const document = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
  if (!Array.isArray(document.entries)) throw new Error(`${path} must contain an entries array`);
  return document.entries.map((entry, index) => {
    const value = entry as { idx?: unknown; tag?: unknown; when?: unknown };
    if (typeof value.tag !== "string" || typeof value.when !== "number") {
      throw new Error(`${path} entry ${index} needs a string tag and numeric when`);
    }
    return {
      idx: typeof value.idx === "number" ? value.idx : index,
      tag: value.tag,
      when: value.when,
    };
  });
}

export class PendingMigrationsError extends Error {
  readonly pending: readonly string[];
  constructor(pending: readonly string[]) {
    super(
      `${pending.length} migration(s) pending: ${pending.join(", ")}. Migrations are applied by the gated release step (ship-schema-lint release), never at boot. Refusing to start.`,
    );
    this.name = "PendingMigrationsError";
    this.pending = pending;
  }
}

export interface AssertMigrationsAppliedOptions {
  readonly client: SnapshotQueryable;
  readonly migrationsDir: string;
  /** Drizzle's defaults. */
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
}

export interface MigrationsStatus {
  readonly applied: number;
  readonly pending: readonly string[];
}

/**
 * Reports which journal entries Drizzle's migrator would still apply, using
 * the same rule the migrator uses: an entry is pending when its `when` is
 * newer than the latest `created_at` in the migrations ledger.
 */
export async function migrationsStatus(
  options: AssertMigrationsAppliedOptions,
): Promise<MigrationsStatus> {
  const journal = await readMigrationJournal(options.migrationsDir);
  const schema = options.migrationsSchema ?? "drizzle";
  const table = options.migrationsTable ?? "__drizzle_migrations";
  let latest: number | undefined;
  try {
    const result = await options.client.query(
      `SELECT created_at FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY created_at DESC LIMIT 1`,
    );
    const value = result.rows[0]?.created_at;
    if (value !== undefined && value !== null) latest = Number(value);
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  const pending = journal
    .filter((entry) => latest === undefined || entry.when > latest)
    .map((entry) => entry.tag);
  return { applied: journal.length - pending.length, pending };
}

/**
 * Boot-time guard: call it where `migrate()` used to run. It never applies a
 * migration; it throws `PendingMigrationsError` so the process fails fast and
 * the operator runs the release step.
 */
export async function assertMigrationsApplied(
  options: AssertMigrationsAppliedOptions,
): Promise<MigrationsStatus> {
  const status = await migrationsStatus(options);
  if (status.pending.length > 0) throw new PendingMigrationsError(status.pending);
  return status;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}
