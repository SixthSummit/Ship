import type { TenantBypass, TenantIdentifier, TenantScope } from "@sixthsummit/ship-core";
import { isTenantScope, recordTenantBypassUse } from "@sixthsummit/ship-core";
import { eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { DrizzleRepositoryError } from "./repository-error.js";

const TENANT_REPOSITORY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

type RequiredTenantColumn = PgColumn & {
  readonly _: {
    readonly data: TenantIdentifier;
    readonly notNull: true;
  };
};

export interface TenantRepositoryContext<TTransaction, TTenantId extends TenantIdentifier> {
  readonly transaction: TTransaction;
  readonly scope: TenantScope<TTenantId>;
}

export interface PrivilegedTenantRepositoryContext<TTransaction> {
  readonly transaction: TTransaction;
  readonly bypass: TenantBypass;
}

export interface TenantRepositoryDefinition<
  TTransaction,
  TTenantId extends TenantIdentifier,
  TScopedRepository,
> {
  readonly id: string;
  /** Active transaction captured by this operation-scoped factory. */
  readonly transaction: TTransaction;
  readonly createScoped: (
    context: TenantRepositoryContext<TTransaction, TTenantId>,
  ) => TScopedRepository;
}

export interface PrivilegedTenantRepositoryDefinition<
  TTransaction,
  TTenantId extends TenantIdentifier,
  TScopedRepository,
  TPrivilegedRepository,
> extends TenantRepositoryDefinition<TTransaction, TTenantId, TScopedRepository> {
  readonly createPrivileged: (
    context: PrivilegedTenantRepositoryContext<TTransaction>,
  ) => TPrivilegedRepository;
}

export interface TenantRepositoryFactory<TTenantId extends TenantIdentifier, TScopedRepository> {
  readonly kind: "ship.drizzle.tenant-repository";
  readonly id: string;
  forTenant(scope: TenantScope<TTenantId>): TScopedRepository;
}

export interface PrivilegedTenantRepositoryFactory<
  TTenantId extends TenantIdentifier,
  TScopedRepository,
  TPrivilegedRepository,
> extends TenantRepositoryFactory<TTenantId, TScopedRepository> {
  withBypass(bypass: TenantBypass): TPrivilegedRepository;
}

export function createTenantRepository<
  TTransaction,
  TScopedRepository,
  TPrivilegedRepository,
  TTenantId extends TenantIdentifier = string,
>(
  definition: PrivilegedTenantRepositoryDefinition<
    TTransaction,
    TTenantId,
    TScopedRepository,
    TPrivilegedRepository
  >,
): PrivilegedTenantRepositoryFactory<TTenantId, TScopedRepository, TPrivilegedRepository>;
export function createTenantRepository<
  TTransaction,
  TScopedRepository,
  TTenantId extends TenantIdentifier = string,
>(
  definition: TenantRepositoryDefinition<TTransaction, TTenantId, TScopedRepository>,
): TenantRepositoryFactory<TTenantId, TScopedRepository>;
/**
 * Captures an active transaction and exposes only capability-gated repository constructors.
 * Include the resulting factory—not the transaction—in the unit-of-work capability map.
 */
export function createTenantRepository(
  definition: TenantRepositoryDefinition<unknown, TenantIdentifier, unknown> & {
    readonly createPrivileged?: (context: PrivilegedTenantRepositoryContext<unknown>) => unknown;
  },
): TenantRepositoryFactory<TenantIdentifier, unknown> & {
  readonly withBypass?: (bypass: TenantBypass) => unknown;
} {
  assertDefinition(definition);
  const forTenant = (scope: TenantScope<TenantIdentifier>): unknown => {
    if (!isTenantScope(scope)) {
      throw tenantRepositoryError(
        "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED",
        definition.id,
        "scoped",
        "tenant repository construction requires an authentic tenant scope",
      );
    }
    return assertRepository(
      definition.id,
      "scoped",
      definition.createScoped(Object.freeze({ transaction: definition.transaction, scope })),
    );
  };

  const factory: Record<string, unknown> = {
    kind: "ship.drizzle.tenant-repository" as const,
    id: definition.id,
    forTenant,
  };
  if (definition.createPrivileged) {
    factory.withBypass = (bypass: TenantBypass): unknown => {
      recordTenantBypassUse(bypass, definition.id);
      return assertRepository(
        definition.id,
        "privileged",
        definition.createPrivileged!(
          Object.freeze({ transaction: definition.transaction, bypass }),
        ),
      );
    };
  }
  return Object.freeze(factory) as unknown as TenantRepositoryFactory<TenantIdentifier, unknown> & {
    readonly withBypass?: (bypass: TenantBypass) => unknown;
  };
}

/** Creates a tenant equality predicate from a non-null PostgreSQL tenant column. */
export function tenantPredicate<TColumn extends RequiredTenantColumn>(
  column: TColumn,
  scope: TenantScope<NoInfer<TColumn["_"]["data"]>>,
): SQL {
  if (!isTenantScope(scope)) {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED",
      undefined,
      "scoped",
      "tenant predicate requires an authentic tenant scope",
    );
  }
  return eq(column, scope.tenantId);
}

function assertDefinition(definition: unknown): asserts definition is TenantRepositoryDefinition<
  unknown,
  TenantIdentifier,
  unknown
> & {
  readonly createPrivileged?: (context: PrivilegedTenantRepositoryContext<unknown>) => unknown;
} {
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      undefined,
      undefined,
      "tenant repository definition must be an object",
    );
  }
  const id = Reflect.get(definition, "id");
  if (typeof id !== "string" || !TENANT_REPOSITORY_ID_PATTERN.test(id)) {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      typeof id === "string" ? id : undefined,
      undefined,
      `tenant repository id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
      "id",
    );
  }
  const transaction = Reflect.get(definition, "transaction");
  if (
    (typeof transaction !== "object" && typeof transaction !== "function") ||
    transaction === null ||
    Array.isArray(transaction)
  ) {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      id,
      undefined,
      "tenant repository must capture an active transaction",
      "transaction",
    );
  }
  if (typeof Reflect.get(definition, "createScoped") !== "function") {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      id,
      undefined,
      "tenant repository must provide createScoped(context)",
      "createScoped",
    );
  }
  const createPrivileged = Reflect.get(definition, "createPrivileged");
  if (createPrivileged !== undefined && typeof createPrivileged !== "function") {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      id,
      undefined,
      "tenant repository createPrivileged must be a function when provided",
      "createPrivileged",
    );
  }
}

function assertRepository(
  repositoryId: string,
  accessMode: "scoped" | "privileged",
  repository: unknown,
): unknown {
  const objectLike =
    (typeof repository === "object" && repository !== null) || typeof repository === "function";
  if (!objectLike || typeof Reflect.get(repository, "then") === "function") {
    throw tenantRepositoryError(
      "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID",
      repositoryId,
      accessMode,
      `tenant repository ${JSON.stringify(repositoryId)} ${accessMode} constructor must return a synchronous object`,
    );
  }
  return repository;
}

function tenantRepositoryError(
  code: "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID" | "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED",
  repositoryId: string | undefined,
  accessMode: "scoped" | "privileged" | undefined,
  message: string,
  field?: string,
): DrizzleRepositoryError {
  return new DrizzleRepositoryError(code, message, { field, repositoryId, accessMode });
}
