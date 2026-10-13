import { getTableColumns, type InferInsertModel, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError, type DrizzleRepositoryErrorCode } from "./repository-error.js";

type InsertModel<TTable extends PgTable> = InferInsertModel<TTable>;
type TableField<TTable extends PgTable> = Extract<keyof TTable["_"]["columns"], string>;
type NullableTableField<TTable extends PgTable> = {
  [TKey in TableField<TTable>]-?: TTable["_"]["columns"][TKey] extends {
    readonly _: { readonly notNull: false };
  }
    ? TKey
    : never;
}[TableField<TTable>];
type ColumnValue<TTable extends PgTable, TKey> = TKey extends keyof TTable["_"]["columns"]
  ? TTable["_"]["columns"][TKey] extends { readonly _: { readonly data: infer TData } }
    ? TData
    : never
  : never;
type OptionalRoleValue<
  TTable extends PgTable,
  TNames,
  TRole extends PropertyKey,
> = TRole extends keyof TNames ? ColumnValue<TTable, TNames[TRole]> : never;
type AuditCreatedActor<
  TTable extends PgTable,
  TNames extends AuditColumnNames<TTable>,
> = OptionalRoleValue<TTable, TNames, "createdBy">;
type AuditUpdatedActor<
  TTable extends PgTable,
  TNames extends AuditColumnNames<TTable>,
> = OptionalRoleValue<TTable, TNames, "updatedBy">;

export interface AuditColumnNames<TTable extends PgTable> {
  readonly createdAt: TableField<TTable>;
  readonly updatedAt: TableField<TTable>;
  readonly createdBy?: TableField<TTable>;
  readonly updatedBy?: TableField<TTable>;
}

export interface AuditStamp<TAt = unknown, TActor = unknown> {
  readonly at: TAt;
  readonly actorId?: TActor;
}

export type CreateAuditStamp<
  TTable extends PgTable,
  TNames extends AuditColumnNames<TTable>,
> = AuditStamp<ColumnValue<TTable, TNames["createdAt"]>, AuditCreatedActor<TTable, TNames>>;

export type UpdateAuditStamp<
  TTable extends PgTable,
  TNames extends AuditColumnNames<TTable>,
> = AuditStamp<ColumnValue<TTable, TNames["updatedAt"]>, AuditUpdatedActor<TTable, TNames>>;

export interface AuditColumns<TTable extends PgTable, TNames extends AuditColumnNames<TTable>> {
  readonly kind: "ship.drizzle.audit-columns";
  readonly names: Readonly<TNames>;
  created(stamp: CreateAuditStamp<TTable, TNames>): Readonly<Partial<InsertModel<TTable>>>;
  updated(stamp: UpdateAuditStamp<TTable, TNames>): Readonly<Partial<InsertModel<TTable>>>;
}

export interface SoftDeleteColumnNames<TTable extends PgTable> {
  readonly deletedAt: NullableTableField<TTable>;
  readonly updatedAt?: TableField<TTable>;
  readonly actor?: TableField<TTable>;
}

export type SoftDeleteStamp<
  TTable extends PgTable,
  TNames extends SoftDeleteColumnNames<TTable>,
> = AuditStamp<
  NonNullable<ColumnValue<TTable, TNames["deletedAt"]>> &
    ([OptionalRoleValue<TTable, TNames, "updatedAt">] extends [never]
      ? unknown
      : OptionalRoleValue<TTable, TNames, "updatedAt">),
  OptionalRoleValue<TTable, TNames, "actor">
>;

export interface SoftDeleteColumns<
  TTable extends PgTable,
  TNames extends SoftDeleteColumnNames<TTable>,
> {
  readonly kind: "ship.drizzle.soft-delete-columns";
  readonly names: Readonly<TNames>;
  active(): SQL;
  deleted(): SQL;
  deletedValues(stamp: SoftDeleteStamp<TTable, TNames>): Readonly<Partial<InsertModel<TTable>>>;
  restoredValues(stamp: SoftDeleteStamp<TTable, TNames>): Readonly<Partial<InsertModel<TTable>>>;
}

/** Maps semantic audit roles onto the consumer's real TypeScript column names. */
export function defineAuditColumns<
  TTable extends PgTable,
  const TNames extends AuditColumnNames<TTable>,
>(table: TTable, names: TNames): AuditColumns<TTable, TNames> {
  const resolved = validateColumnNames(
    table,
    names,
    ["createdAt", "updatedAt"],
    ["createdBy", "updatedBy"],
    "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID",
  ) as Readonly<TNames>;
  const createdAt = resolved.createdAt as string;
  const updatedAt = resolved.updatedAt as string;
  const createdBy = resolved.createdBy as string | undefined;
  const updatedBy = resolved.updatedBy as string | undefined;

  return Object.freeze({
    kind: "ship.drizzle.audit-columns" as const,
    names: resolved,
    created: (stamp: AuditStamp) => {
      assertStamp(stamp, "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID");
      const values: Record<string, unknown> = { [createdAt]: stamp.at };
      assignActor(values, createdBy, stamp.actorId);
      return Object.freeze(values) as Readonly<Partial<InsertModel<TTable>>>;
    },
    updated: (stamp: AuditStamp) => {
      assertStamp(stamp, "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID");
      const values: Record<string, unknown> = { [updatedAt]: stamp.at };
      assignActor(values, updatedBy, stamp.actorId);
      return Object.freeze(values) as Readonly<Partial<InsertModel<TTable>>>;
    },
  });
}

/** Defines explicit active/deleted predicates and mutation values for one table. */
export function defineSoftDeleteColumns<
  TTable extends PgTable,
  const TNames extends SoftDeleteColumnNames<TTable>,
>(table: TTable, names: TNames): SoftDeleteColumns<TTable, TNames> {
  const resolved = validateColumnNames(
    table,
    names,
    ["deletedAt"],
    ["updatedAt", "actor"],
    "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID",
  ) as Readonly<TNames>;
  const columns = getTableColumns(table) as Record<string, Parameters<typeof isNull>[0]>;
  const deletedAtName = resolved.deletedAt as string;
  const updatedAt = resolved.updatedAt as string | undefined;
  const actor = resolved.actor as string | undefined;
  const deletedAt = columns[deletedAtName]!;

  const mutationValues = (stamp: AuditStamp, deleted: boolean) => {
    assertStamp(stamp, "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID");
    const values: Record<string, unknown> = {
      [deletedAtName]: deleted ? stamp.at : null,
    };
    if (updatedAt) values[updatedAt] = stamp.at;
    assignActor(values, actor, stamp.actorId);
    return Object.freeze(values) as Readonly<Partial<InsertModel<TTable>>>;
  };

  return Object.freeze({
    kind: "ship.drizzle.soft-delete-columns" as const,
    names: resolved,
    active: () => isNull(deletedAt),
    deleted: () => isNotNull(deletedAt),
    deletedValues: (stamp: AuditStamp) => mutationValues(stamp, true),
    restoredValues: (stamp: AuditStamp) => mutationValues(stamp, false),
  });
}

function validateColumnNames(
  table: PgTable,
  names: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: DrizzleRepositoryErrorCode,
): Readonly<Record<string, string>> {
  if (typeof names !== "object" || names === null || Array.isArray(names)) {
    throw columnError(code, "column role mapping must be an object");
  }
  const columns = getTableColumns(table) as Record<string, unknown>;
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  const allowed = new Set([...required, ...optional]);

  for (const role of Object.keys(names)) {
    if (!allowed.has(role)) {
      throw columnError(code, `unknown column role ${JSON.stringify(role)}`, role);
    }
  }

  for (const role of allowed) {
    const value = Reflect.get(names, role);
    if (value === undefined && optional.includes(role)) continue;
    if (typeof value !== "string" || !Object.hasOwn(columns, value)) {
      throw columnError(code, `${role} must name a column on the configured table`, role);
    }
    if (seen.has(value)) {
      throw columnError(code, `column ${JSON.stringify(value)} cannot serve multiple roles`, role);
    }
    seen.add(value);
    result[role] = value;
  }

  return Object.freeze(result);
}

function assertStamp(
  stamp: unknown,
  code: DrizzleRepositoryErrorCode,
): asserts stamp is AuditStamp {
  if (
    typeof stamp !== "object" ||
    stamp === null ||
    Array.isArray(stamp) ||
    Reflect.get(stamp, "at") === undefined
  ) {
    throw columnError(code, "audit stamp must provide an at value", "at");
  }
}

function assignActor(values: Record<string, unknown>, name: string | undefined, actor: unknown) {
  if (name && actor !== undefined) values[name] = actor;
}

function columnError(
  code: DrizzleRepositoryErrorCode,
  message: string,
  field?: string,
): DrizzleRepositoryError {
  return new DrizzleRepositoryError(code, message, { field });
}
