import type { CacheBackend, CacheBackendDependencyToken } from "./cache.js";
import { scopedCacheTag } from "./cache.js";
import type { DependencyToken, EffectDependencyToken } from "./dependency.js";
import { effectDependency } from "./dependency.js";
import { objectSchema, optionalSchema, stringSchema } from "./framework-schema.js";
import { defineModule } from "./module.js";
import type { OutboxBackend, OutboxBackoff } from "./outbox.js";
import {
  defineOutbox,
  defineOutboxCleanup,
  defineOutboxDispatcher,
  type OutboxDispatcher,
  outboxIntent,
} from "./outbox.js";
import { valueProvider } from "./provider.js";

/** The module id a mounted cache-invalidation module must use. */
export const CACHE_INVALIDATION_MODULE_ID = "ship-cache";
export const CACHE_INVALIDATION_OUTBOX_ID = "ship-cache.invalidation";
/** The single intent: purge every entry stored under one tag. */
export const CACHE_INVALIDATION_INTENT_ID = "purge-tag";

const DEFAULT_RETENTION = Object.freeze({
  completedMs: 24 * 60 * 60 * 1000,
  deadLetteredMs: 30 * 24 * 60 * 60 * 1000,
});
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_BACKOFF = Object.freeze({ initialMs: 250, multiplier: 2, maxMs: 60_000 });

/**
 * The effect a mounted cache-invalidation module binds to the live cache
 * backend. The dispatcher performs the purge through it, outside any
 * transaction, exactly like any other declared immediate effect (ADR-0010).
 */
export const cacheInvalidationEffect: EffectDependencyToken<CacheBackend> =
  effectDependency<CacheBackend>("ship-cache.backend", { delivery: "immediate" });

/**
 * `scope` is the cache scope key of the subject the purge is narrowed to
 * (`actor:<id>` or `tenant:<key>`, the same key that keyed the entries). When
 * absent the plain tag is purged for every subject.
 */
const purgePayloadSchema = objectSchema({
  tag: stringSchema({ minLength: 1 }),
  scope: optionalSchema(stringSchema({ minLength: 1 })),
});

/**
 * Framework-owned durable outbox for cache invalidation. A write operation
 * declaring `invalidates` records one purge intent per tag in its own write
 * transaction, so the intent commits or rolls back with the business change.
 * The dispatcher performs the purge afterwards: invalidation is eventual, and
 * a read between commit and dispatch may still observe a cached value.
 */
export const cacheInvalidationOutbox = defineOutbox({
  id: CACHE_INVALIDATION_OUTBOX_ID,
  retention: DEFAULT_RETENTION,
  intents: {
    [CACHE_INVALIDATION_INTENT_ID]: outboxIntent({
      payload: purgePayloadSchema,
      effect: cacheInvalidationEffect,
      perform: async ({ effect, payload }) => {
        await effect.delByTag(
          payload.scope === undefined ? payload.tag : scopedCacheTag(payload.tag, payload.scope),
        );
      },
    }),
  },
});

export interface CacheInvalidationDispatcherOptions {
  readonly batchSize?: number;
  readonly lease?: { readonly ms: number };
  readonly retry?: { readonly attempts: number; readonly backoff: OutboxBackoff };
  readonly clock?: () => Date;
}

/** Generates `ship-cache.invalidation.dispatch` plus its dead-letter operations. */
export function defineCacheInvalidationDispatcher(
  options: CacheInvalidationDispatcherOptions = {},
): OutboxDispatcher<
  typeof CACHE_INVALIDATION_OUTBOX_ID,
  (typeof cacheInvalidationOutbox)["intents"]
> {
  return defineOutboxDispatcher(cacheInvalidationOutbox, {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    lease: options.lease ?? { ms: DEFAULT_LEASE_MS },
    retry: options.retry ?? { attempts: DEFAULT_ATTEMPTS, backoff: DEFAULT_BACKOFF },
    deadLetter: true,
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

export interface CacheInvalidationModuleOptions extends CacheInvalidationDispatcherOptions {
  /** The live cache the dispatcher purges. */
  readonly cache: CacheBackend;
  /** Durable storage for purge intents; must join the write transaction. */
  readonly outbox: OutboxBackend;
  /**
   * When given, the module also binds `cache` to this `cacheBackendDependency`
   * token and exports it, so a module with cached reads only imports
   * `ship-cache` and binds nothing itself.
   */
  readonly backend?: CacheBackendDependencyToken;
}

/**
 * The module a consumer mounts once. It owns the purge intent storage, the
 * dispatcher, its dead-letter operations and the cleanup operation, so a
 * consumer only declares `cache` on reads and `invalidates` on writes.
 *
 * Every module containing an operation that declares `invalidates` must import
 * {@link CACHE_INVALIDATION_MODULE_ID}; so must every module with a cached read
 * when `backend` is given, because this module then owns that binding.
 *
 * Mounting it introduces the framework permission `ship.outbox:manage`, which
 * gates the generated dead-letter operations.
 */
export function defineCacheInvalidationModule(options: CacheInvalidationModuleOptions) {
  const dispatcher = defineCacheInvalidationDispatcher(options);
  const cleanup = defineOutboxCleanup(
    cacheInvalidationOutbox,
    options.clock ? { clock: options.clock } : {},
  );
  const exported: DependencyToken[] = [cacheInvalidationOutbox.writer, cacheInvalidationEffect];
  const providers = [
    valueProvider(cacheInvalidationOutbox.writer, options.outbox),
    valueProvider(cacheInvalidationEffect, options.cache),
  ];
  if (options.backend) {
    providers.push(valueProvider(options.backend, options.cache));
    exported.push(options.backend);
  }
  return defineModule({
    id: CACHE_INVALIDATION_MODULE_ID,
    operations: [...dispatcher.operations, cleanup],
    providers,
    imports: [],
    exports: exported,
  });
}
