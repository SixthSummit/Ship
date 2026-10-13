/**
 * Lifecycle hooks for `EntityService` / `DrizzleEntityService`.
 *
 * Foundation contract that lets v4.x ship audit-trail, change-data-capture,
 * webhook-fan-out, and tenant-scoping modules without service-by-service surgery.
 *
 * Hooks run inside the same transaction as the operation when one is active.
 * `before*` hooks return either `void` (continue) or a transformed value
 * (mutate the operation). `after*` hooks are observation-only.
 *
 * Compose multiple hook sets via `composeHooks(...)`; subclasses can override
 * `getHooks()` on a service to register service-specific hooks alongside
 * globally-composed ones.
 *
 * The hook context is the canonical framework-wide `RequestContext` (single
 * AsyncLocalStorage instance) — same shape as what the logger and
 * `withTransaction` see. `userId` carries the actor; the full user object is
 * not stored in the context (hooks fetch it from the DB if they need it).
 */

import type { RequestContext } from "../../context/RequestContext.js";

/** Alias kept for ergonomic imports — same shape as `RequestContext`. */
export type LifecycleHookContext = RequestContext;

export interface QueryFilter {
  // Neutral query DSL — formalized in `services/interfaces/QueryOptions.ts`.
  // Kept loose here to avoid circular type deps at the hook layer.
  [key: string]: unknown;
}

/**
 * Hook signatures. Each hook is optional; missing hooks are skipped.
 * Generic over the row/insert/update types so subclasses get type safety.
 */
export interface LifecycleHooks<TRow = unknown, TInsert = unknown, TPatch = unknown> {
  /** Before an INSERT. Return a transformed `values` to mutate; return void to continue. */
  beforeCreate?(
    values: TInsert,
    ctx: LifecycleHookContext,
  ): Promise<TInsert | void> | TInsert | void;

  /** After an INSERT. Observation-only. */
  afterCreate?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  /**
   * Before an UPDATE. `prev` is loaded before the write so audit consumers can diff.
   * Return a transformed `patch` to mutate; return void to continue.
   */
  beforeUpdate?(
    prev: TRow,
    patch: TPatch,
    ctx: LifecycleHookContext,
  ): Promise<TPatch | void> | TPatch | void;

  /** After an UPDATE. Observation-only. Receives both prev and next for diffing. */
  afterUpdate?(prev: TRow, next: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  /** Before a DELETE (or soft-delete). Throw to abort the operation. */
  beforeDelete?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  /** After a DELETE / soft-delete. Observation-only. */
  afterDelete?(row: TRow, ctx: LifecycleHookContext): Promise<void> | void;

  /**
   * Before any read query. Return a transformed filter to mutate (e.g., inject
   * `tenantId = currentTenantId` for multi-tenancy). Return void to continue.
   */
  beforeQuery?(
    filter: QueryFilter,
    ctx: LifecycleHookContext,
  ): Promise<QueryFilter | void> | QueryFilter | void;
}

/**
 * Compose multiple hook sets into one. Hooks fire in registration order for
 * `before*` (so each can transform the result of the previous) and in reverse
 * order for `after*` (LIFO — useful for nested cross-cutting concerns).
 *
 * Returning `undefined` from a `before*` hook means "no change"; the next hook
 * receives the unchanged value from the previous step.
 */
export function composeHooks<TRow, TInsert, TPatch>(
  ...sets: Array<LifecycleHooks<TRow, TInsert, TPatch>>
): LifecycleHooks<TRow, TInsert, TPatch> {
  return {
    async beforeCreate(values, ctx) {
      let current = values;
      for (const set of sets) {
        if (!set.beforeCreate) continue;
        const r = await set.beforeCreate(current, ctx);
        if (r !== undefined) current = r as TInsert;
      }
      return current;
    },

    async afterCreate(row, ctx) {
      for (let i = sets.length - 1; i >= 0; i--) {
        await sets[i].afterCreate?.(row, ctx);
      }
    },

    async beforeUpdate(prev, patch, ctx) {
      let current = patch;
      for (const set of sets) {
        if (!set.beforeUpdate) continue;
        const r = await set.beforeUpdate(prev, current, ctx);
        if (r !== undefined) current = r as TPatch;
      }
      return current;
    },

    async afterUpdate(prev, next, ctx) {
      for (let i = sets.length - 1; i >= 0; i--) {
        await sets[i].afterUpdate?.(prev, next, ctx);
      }
    },

    async beforeDelete(row, ctx) {
      for (const set of sets) {
        await set.beforeDelete?.(row, ctx);
      }
    },

    async afterDelete(row, ctx) {
      for (let i = sets.length - 1; i >= 0; i--) {
        await sets[i].afterDelete?.(row, ctx);
      }
    },

    async beforeQuery(filter, ctx) {
      let current = filter;
      for (const set of sets) {
        if (!set.beforeQuery) continue;
        const r = await set.beforeQuery(current, ctx);
        if (r !== undefined) current = r as QueryFilter;
      }
      return current;
    },
  };
}
