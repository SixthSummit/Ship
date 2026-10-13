import { TransactionRollbackError } from "drizzle-orm/errors";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { withSpan } from "../../observability/tracing.js";
import { setRequestContextField } from "../context/RequestContext.js";

/**
 * `withTransaction` — opens a Drizzle transaction with framework value-add.
 *
 * Beyond Drizzle's bare `db.transaction(...)` this wrapper provides:
 *
 * 1. **OTel span** named `db.transaction` so transaction duration shows up in
 *    traces with the same correlation IDs as the surrounding request.
 * 2. **Translation of `TransactionRollbackError`** into ShipAPI's
 *    `RollbackError` so `catch (Error)` blocks in callers don't accidentally
 *    swallow a rollback as a generic application failure. Raw Drizzle
 *    rollbacks are easy to misuse; this gives them a typed identity.
 * 3. **Optional retry-on-deadlock** for serialization failures (Postgres SQLSTATE
 *    `40001`) and deadlocks (`40P01`). Off by default; opt in via
 *    `retryOnConflict: { attempts: 3, backoffMs: 50 }`.
 * 4. **`RequestContext.tx` propagation** — while inside the callback, the
 *    canonical request context's `tx` field is set so lifecycle hooks
 *    (audit / CDC / multi-tenant) running in nested service calls know
 *    they're inside an active transaction without explicit threading.
 */

export class RollbackError extends Error {
  readonly cause?: unknown;
  constructor(message = "Transaction rolled back", cause?: unknown) {
    super(message);
    this.name = "RollbackError";
    this.cause = cause;
  }
}

type AnyDb<TSchema extends Record<string, unknown>> = NodePgDatabase<TSchema>;

export type ShipTx<TSchema extends Record<string, unknown>> = PgTransaction<
  NodePgQueryResultHKT,
  TSchema,
  ExtractTablesWithRelations<TSchema>
>;

export interface WithTransactionOptions {
  /**
   * Retry the transaction on Postgres serialization failures and deadlocks.
   * Defaults to `undefined` (no retry).
   */
  retryOnConflict?: { attempts: number; backoffMs: number };
  /** Custom span name override. Defaults to `"db.transaction"`. */
  spanName?: string;
}

const POSTGRES_RETRYABLE_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

function isRetryablePgError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && POSTGRES_RETRYABLE_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` inside a Drizzle transaction. The `tx` argument is the same
 * Drizzle transaction client your service code would receive from `db.transaction(...)` —
 * use it for all writes inside the callback so they share the transaction
 * scope.
 *
 * Throwing from the callback rolls back. Calling `tx.rollback()` also rolls
 * back (translated to `RollbackError`).
 *
 * @example
 * await withTransaction(db, async (tx) => {
 *   await tx.insert(accounts).values(values);
 *   await tx.insert(auditLog).values(diff);
 * });
 */
export async function withTransaction<TSchema extends Record<string, unknown>, T>(
  db: AnyDb<TSchema>,
  fn: (tx: ShipTx<TSchema>) => Promise<T>,
  opts: WithTransactionOptions = {},
): Promise<T> {
  const spanName = opts.spanName ?? "db.transaction";
  const retry = opts.retryOnConflict;
  const maxAttempts = retry?.attempts ?? 1;
  const backoffMs = retry?.backoffMs ?? 0;

  return withSpan(spanName, async (span) => {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await db.transaction(async (tx) => {
          // Make `tx` visible to lifecycle hooks running in nested service calls.
          setRequestContextField("tx", tx);
          try {
            return await fn(tx as ShipTx<TSchema>);
          } finally {
            setRequestContextField("tx", undefined);
          }
        });
      } catch (err) {
        lastErr = err;

        // Drizzle marks intentional rollbacks via TransactionRollbackError.
        if (err instanceof TransactionRollbackError) {
          const wrapped = new RollbackError("Transaction rolled back via tx.rollback()", err);
          span.setAttribute("db.rollback.kind", "explicit");
          throw wrapped;
        }

        if (attempt < maxAttempts && retry && isRetryablePgError(err)) {
          span.addEvent("db.transaction.retry", {
            attempt,
            "error.code": (err as { code?: string }).code ?? "unknown",
          });
          if (backoffMs > 0) await delay(backoffMs * attempt);
          continue;
        }

        throw err;
      }
    }

    // Unreachable in practice — last attempt either returned or threw above.
    /* c8 ignore next */
    throw lastErr;
  });
}
