import { AsyncLocalStorage } from "node:async_hooks";
import type { UnitOfWork } from "@sixthsummit/ship-core";
import type { NodePgDatabase, NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction, PgTransactionConfig } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

const UNIT_OF_WORK_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const CAPABILITY_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;
const activeUnits = new AsyncLocalStorage<ReadonlyMap<symbol, ActiveUnitOfWork>>();
/**
 * Process-local, nominal association between a frozen capability map and the
 * Drizzle transaction it was built from. Adapters that must join the active
 * transaction (outbox writers, idempotency stores) resolve it from the scope
 * the executor hands them instead of from ambient state.
 */
const scopeTransactions = new WeakMap<object, unknown>();

export type UnitOfWorkMode = "read" | "write";
export type NestedUnitOfWorkPolicy = "join" | "reject";
export type UnitOfWorkCapabilities = Readonly<Record<string, unknown>>;

export type DrizzleTransaction<TSchema extends Record<string, unknown>> = PgTransaction<
  NodePgQueryResultHKT,
  TSchema,
  ExtractTablesWithRelations<TSchema>
>;

export interface DrizzleUnitOfWorkDefinition<
  TSchema extends Record<string, unknown>,
  TCapabilities extends UnitOfWorkCapabilities,
> {
  /** Stable diagnostic identifier for this database boundary. */
  readonly id: string;
  /** Retained privately; it is never exposed to transactional work. */
  readonly database: NodePgDatabase<TSchema>;
  /** Constructs the only repositories/capabilities visible inside the transaction. */
  readonly create: (transaction: DrizzleTransaction<TSchema>) => TCapabilities;
  /** Nested calls join by default. `reject` fails before running nested work. */
  readonly nested?: NestedUnitOfWorkPolicy;
}

export interface DrizzleUnitOfWork<TCapabilities extends UnitOfWorkCapabilities> {
  readonly kind: "ship.unit-of-work";
  readonly adapter: "drizzle";
  readonly id: string;
  readonly nested: NestedUnitOfWorkPolicy;
  run<TResult>(
    mode: UnitOfWorkMode,
    work: (capabilities: TCapabilities) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

export type DrizzleUnitOfWorkErrorCode =
  | "SHIP_DRIZZLE_UNIT_OF_WORK_INVALID"
  | "SHIP_DRIZZLE_UNIT_OF_WORK_MODE_INVALID"
  | "SHIP_DRIZZLE_UNIT_OF_WORK_WORK_INVALID"
  | "SHIP_DRIZZLE_UNIT_OF_WORK_CAPABILITIES_INVALID"
  | "SHIP_DRIZZLE_NESTED_TRANSACTION_REJECTED"
  | "SHIP_DRIZZLE_TRANSACTION_MODE_ESCALATION"
  | "SHIP_DRIZZLE_TRANSACTION_SCOPE_CLOSED";

export class DrizzleUnitOfWorkError extends Error {
  readonly code: DrizzleUnitOfWorkErrorCode;
  readonly unitOfWorkId?: string;
  readonly capability?: string;

  constructor(
    code: DrizzleUnitOfWorkErrorCode,
    message: string,
    options: { readonly unitOfWorkId?: string; readonly capability?: string } = {},
  ) {
    super(message);
    this.name = "DrizzleUnitOfWorkError";
    this.code = code;
    this.unitOfWorkId = options.unitOfWorkId;
    this.capability = options.capability;
  }
}

interface ActiveUnitOfWork {
  readonly mode: UnitOfWorkMode;
  readonly capabilities: UnitOfWorkCapabilities;
  readonly state: ActiveUnitOfWorkState;
}

interface ActiveUnitOfWorkState {
  closed: boolean;
  rollbackOnly: boolean;
  rollbackCause?: unknown;
}

/**
 * Creates a PostgreSQL/Drizzle transaction boundary whose callback can see
 * only repositories and capabilities constructed from the active transaction.
 */
export function createDrizzleUnitOfWork<
  TSchema extends Record<string, unknown>,
  const TCapabilities extends UnitOfWorkCapabilities,
>(
  definition: DrizzleUnitOfWorkDefinition<TSchema, TCapabilities>,
): DrizzleUnitOfWork<TCapabilities> {
  assertDefinition(definition);
  const nested = definition.nested ?? "join";
  const instance = Symbol(definition.id);

  const run = async <TResult>(
    mode: UnitOfWorkMode,
    work: (capabilities: TCapabilities) => TResult | Promise<TResult>,
  ): Promise<TResult> => {
    assertRunArguments(definition.id, mode, work);
    const currentStore = activeUnits.getStore();
    const active = currentStore?.get(instance);
    if (active) {
      if (active.state.closed) {
        throw new DrizzleUnitOfWorkError(
          "SHIP_DRIZZLE_TRANSACTION_SCOPE_CLOSED",
          `unit of work ${JSON.stringify(definition.id)} cannot reuse a completed transaction scope`,
          { unitOfWorkId: definition.id },
        );
      }
      if (nested === "reject") {
        return rejectNested(
          active,
          new DrizzleUnitOfWorkError(
            "SHIP_DRIZZLE_NESTED_TRANSACTION_REJECTED",
            `unit of work ${JSON.stringify(definition.id)} does not allow nested run() calls`,
            { unitOfWorkId: definition.id },
          ),
        );
      }
      if (active.mode === "read" && mode === "write") {
        return rejectNested(
          active,
          new DrizzleUnitOfWorkError(
            "SHIP_DRIZZLE_TRANSACTION_MODE_ESCALATION",
            `unit of work ${JSON.stringify(definition.id)} cannot join write work to a read-only transaction`,
            { unitOfWorkId: definition.id },
          ),
        );
      }
      try {
        return await work(active.capabilities as TCapabilities);
      } catch (error) {
        markRollbackOnly(active, error);
        throw error;
      }
    }

    return definition.database.transaction(async (transaction) => {
      const capabilities = freezeCapabilities(
        definition.id,
        definition.create(transaction as DrizzleTransaction<TSchema>),
      ) as TCapabilities;
      scopeTransactions.set(capabilities, transaction);
      const state: ActiveUnitOfWorkState = { closed: false, rollbackOnly: false };
      const nextStore = new Map(currentStore);
      nextStore.set(instance, Object.freeze({ mode, capabilities, state }));
      try {
        const result = await activeUnits.run(nextStore, () => work(capabilities));
        if (state.rollbackOnly) throw state.rollbackCause;
        return result;
      } finally {
        state.closed = true;
      }
    }, transactionConfig(mode));
  };

  return Object.freeze({
    kind: "ship.unit-of-work" as const,
    adapter: "drizzle" as const,
    id: definition.id,
    nested,
    run,
  }) satisfies DrizzleUnitOfWork<TCapabilities> & UnitOfWork<TCapabilities>;
}

/**
 * Returns the Drizzle transaction behind an active unit-of-work capability map,
 * or undefined when the scope was not produced by a Drizzle unit of work.
 */
export function transactionForScope<TSchema extends Record<string, unknown>>(
  scope: unknown,
): DrizzleTransaction<TSchema> | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  return scopeTransactions.get(scope) as DrizzleTransaction<TSchema> | undefined;
}

function rejectNested(active: ActiveUnitOfWork, error: Error): never {
  markRollbackOnly(active, error);
  throw error;
}

function markRollbackOnly(active: ActiveUnitOfWork, error: unknown): void {
  if (active.state.rollbackOnly) return;
  active.state.rollbackOnly = true;
  active.state.rollbackCause = error;
}

function assertDefinition(
  definition: unknown,
): asserts definition is DrizzleUnitOfWorkDefinition<
  Record<string, unknown>,
  UnitOfWorkCapabilities
> {
  if (typeof definition !== "object" || definition === null) {
    throw invalidDefinition("unit-of-work definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  if (typeof id !== "string" || !UNIT_OF_WORK_ID_PATTERN.test(id)) {
    throw invalidDefinition(
      `unit-of-work id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
    );
  }
  const database = Reflect.get(definition, "database");
  if (
    typeof database !== "object" ||
    database === null ||
    typeof Reflect.get(database, "transaction") !== "function"
  ) {
    throw invalidDefinition("unit-of-work database must provide transaction(callback, config)", id);
  }
  if (typeof Reflect.get(definition, "create") !== "function") {
    throw invalidDefinition("unit-of-work create must be a function", id);
  }
  const nested = Reflect.get(definition, "nested");
  if (nested !== undefined && nested !== "join" && nested !== "reject") {
    throw invalidDefinition("unit-of-work nested policy must be join or reject", id);
  }
}

function assertRunArguments(
  id: string,
  mode: unknown,
  work: unknown,
): asserts mode is UnitOfWorkMode {
  if (mode !== "read" && mode !== "write") {
    throw new DrizzleUnitOfWorkError(
      "SHIP_DRIZZLE_UNIT_OF_WORK_MODE_INVALID",
      `unit of work ${JSON.stringify(id)} mode must be read or write`,
      { unitOfWorkId: id },
    );
  }
  if (typeof work !== "function") {
    throw new DrizzleUnitOfWorkError(
      "SHIP_DRIZZLE_UNIT_OF_WORK_WORK_INVALID",
      `unit of work ${JSON.stringify(id)} work must be a function`,
      { unitOfWorkId: id },
    );
  }
}

function freezeCapabilities(id: string, capabilities: unknown): UnitOfWorkCapabilities {
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    Array.isArray(capabilities) ||
    typeof Reflect.get(capabilities, "then") === "function"
  ) {
    throw new DrizzleUnitOfWorkError(
      "SHIP_DRIZZLE_UNIT_OF_WORK_CAPABILITIES_INVALID",
      `unit of work ${JSON.stringify(id)} create must return a synchronous capability map`,
      { unitOfWorkId: id },
    );
  }

  const entries: [string, unknown][] = [];
  for (const [name, capability] of Object.entries(capabilities)) {
    if (!CAPABILITY_NAME_PATTERN.test(name) || capability === undefined) {
      throw new DrizzleUnitOfWorkError(
        "SHIP_DRIZZLE_UNIT_OF_WORK_CAPABILITIES_INVALID",
        `unit of work ${JSON.stringify(id)} returned invalid capability ${JSON.stringify(name)}`,
        { unitOfWorkId: id, capability: name },
      );
    }
    entries.push([name, capability]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function transactionConfig(mode: UnitOfWorkMode): PgTransactionConfig {
  return Object.freeze({ accessMode: mode === "read" ? "read only" : "read write" });
}

function invalidDefinition(message: string, unitOfWorkId?: string): DrizzleUnitOfWorkError {
  return new DrizzleUnitOfWorkError("SHIP_DRIZZLE_UNIT_OF_WORK_INVALID", message, {
    unitOfWorkId,
  });
}
