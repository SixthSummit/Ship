import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { withTransaction } from "../../db/transaction.js";
import type {
  IssueRefreshTokenInput,
  RefreshTokenRecord,
  RefreshTokenStore,
} from "./RefreshTokenStore.js";

/**
 * `DrizzleRefreshTokenStore` — Postgres-backed implementation of the refresh-
 * token rotation contract.
 *
 * Works against any `refresh_tokens`-shaped table (the reference table lives in
 * `modules/accounts/schema.ts`). Pulls the table reference in via the
 * constructor so consumers who customize the schema (extending columns,
 * renaming, multi-tenancy) can pass their own table without forking this class.
 *
 * `revokeChain()` uses a single recursive CTE that walks both directions
 * (ancestors via `replaced_by_id` lookups, descendants via the same column
 * forward) so reuse-detection completes in one round-trip even on long
 * chains. The CTE is marked stable for query planning.
 */

/**
 * Structural shape of the `refresh_tokens` table the store relies on. Kept
 * narrow on purpose — consumers can extend the table with extra columns and
 * still satisfy this contract.
 */
export interface RefreshTokensTable {
  id: unknown;
  accountId: unknown;
  tokenHash: unknown;
  expiresAt: unknown;
  revokedAt: unknown;
  replacedById: unknown;
  userAgent: unknown;
  issuedFromIp: unknown;
}

type RefreshTokensPgTable = PgTable & {
  id: { name: string };
  accountId: { name: string };
  tokenHash: { name: string };
  expiresAt: { name: string };
  revokedAt: { name: string };
  replacedById: { name: string };
  userAgent: { name: string };
  issuedFromIp: { name: string };
};

interface RefreshTokenRow {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  userAgent: string | null;
  issuedFromIp: string | null;
}

export interface DrizzleRefreshTokenStoreOptions<TSchema extends Record<string, unknown>> {
  db: NodePgDatabase<TSchema>;
  /**
   * Reference to the `refresh_tokens` table — e.g. the one exported from your
   * accounts module (`modules/accounts/schema.ts`). Must satisfy the structural
   * columns above.
   */
  table: RefreshTokensPgTable;
}

export class DrizzleRefreshTokenStore<TSchema extends Record<string, unknown>>
  implements RefreshTokenStore
{
  private readonly db: NodePgDatabase<TSchema>;
  private readonly table: RefreshTokensPgTable;

  constructor(opts: DrizzleRefreshTokenStoreOptions<TSchema>) {
    this.db = opts.db;
    this.table = opts.table;
  }

  async issue(input: IssueRefreshTokenInput): Promise<RefreshTokenRecord> {
    const [row] = await this.db
      .insert(this.table)
      .values({
        accountId: input.accountId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        userAgent: input.userAgent ?? null,
        issuedFromIp: input.issuedFromIp ?? null,
      } as never)
      .returning();
    return rowToRecord(row as unknown as RefreshTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.tokenHash as never, tokenHash))
      .limit(1);
    if (!rows.length) return null;
    return rowToRecord(rows[0] as unknown as RefreshTokenRow);
  }

  async rotate(oldId: string, newToken: IssueRefreshTokenInput): Promise<RefreshTokenRecord> {
    return withTransaction(this.db, async (tx) => {
      const [inserted] = await tx
        .insert(this.table)
        .values({
          accountId: newToken.accountId,
          tokenHash: newToken.tokenHash,
          expiresAt: newToken.expiresAt,
          userAgent: newToken.userAgent ?? null,
          issuedFromIp: newToken.issuedFromIp ?? null,
        } as never)
        .returning();
      const row = inserted as unknown as RefreshTokenRow;

      await tx
        .update(this.table)
        .set({ replacedById: row.id } as never)
        .where(eq(this.table.id as never, oldId));

      return rowToRecord(row);
    });
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .update(this.table)
      .set({ revokedAt: new Date() } as never)
      .where(and(eq(this.table.id as never, id), isNull(this.table.revokedAt as never)));
  }

  async revokeChain(id: string): Promise<number> {
    // Single-shot: a recursive CTE collects every ancestor + descendant
    // reachable from `id`, then a single UPDATE flips them all to revoked.
    // Stable across Postgres ≥12.
    const tableName = sql.identifier(getTableName(this.table));
    const result = await this.db.execute(sql`
      WITH RECURSIVE forward AS (
        SELECT id, replaced_by_id FROM ${tableName} WHERE id = ${id}
        UNION ALL
        SELECT t.id, t.replaced_by_id
        FROM ${tableName} t
        JOIN forward f ON t.id = f.replaced_by_id
      ),
      backward AS (
        SELECT id, replaced_by_id FROM ${tableName} WHERE id = ${id}
        UNION ALL
        SELECT t.id, t.replaced_by_id
        FROM ${tableName} t
        JOIN backward b ON t.replaced_by_id = b.id
      ),
      chain AS (
        SELECT id FROM forward UNION SELECT id FROM backward
      )
      UPDATE ${tableName} SET revoked_at = NOW()
      WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL
      RETURNING id
    `);
    return readRowCount(result);
  }

  async revokeAllForAccount(accountId: string): Promise<number> {
    const result = await this.db
      .update(this.table)
      .set({ revokedAt: new Date() } as never)
      .where(
        and(
          eq(this.table.accountId as never, accountId),
          or(
            isNull(this.table.revokedAt as never),
            // No-op clause keeps the predicate non-empty if `or` collapses.
            sql`false`,
          ),
        ),
      )
      .returning({ id: this.table.id as never });
    return result.length;
  }
}

function rowToRecord(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedById: row.replacedById,
    userAgent: row.userAgent,
    issuedFromIp: row.issuedFromIp,
  };
}

function getTableName(table: PgTable): string {
  // Drizzle exposes table metadata via the `Symbol.for('drizzle:Name')` slot.
  // Falls back to the inline name for forward-compat with future Drizzle
  // versions that may shift the symbol.
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.description?.includes("drizzle") || s.description?.includes("Name"),
  );
  if (sym) {
    const value = (table as unknown as Record<symbol, unknown>)[sym];
    if (typeof value === "string") return value;
  }
  // Last resort — every PgTable carries a stringifiable identifier.
  return String((table as { _: { name?: string } })._?.name ?? "refresh_tokens");
}

function readRowCount(result: unknown): number {
  // node-postgres returns `{ rows, rowCount, ... }`; Drizzle's `execute`
  // forwards that shape. Guard for shape drift across drivers.
  const r = result as { rowCount?: number; rows?: unknown[] };
  if (typeof r.rowCount === "number") return r.rowCount;
  if (Array.isArray(r.rows)) return r.rows.length;
  return 0;
}
