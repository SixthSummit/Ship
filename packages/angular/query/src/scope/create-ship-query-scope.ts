import { signal, untracked } from '@angular/core';
import { isShipQueryScopeKey } from './is-ship-query-scope-key';
import type { ShipQueryScopeConfig } from './ship-query-scope-config';
import type { ShipQueryScopeController } from './ship-query-scope-controller';
import type { ShipQueryScopeSnapshot } from './ship-query-scope-snapshot';

/** Own one cache identity lifecycle without depending on an authentication provider. */
export function createShipQueryScope(config: ShipQueryScopeConfig): ShipQueryScopeController {
  if (typeof config.namespace !== 'string' || config.namespace.length === 0) {
    throw new Error('Ship query namespace must be a non-empty string');
  }
  const namespace = config.namespace;
  const cache = config.cache;
  const fixed = config.fixed === true;
  const snapshot = (scopeKey: string, generation: number): ShipQueryScopeSnapshot => {
    if (typeof scopeKey !== 'string' || scopeKey.length === 0) {
      throw new Error('Ship query scopeKey must be a non-empty string');
    }
    return Object.freeze({ namespace, scopeKey, generation });
  };
  const current = signal(snapshot(config.scopeKey, 0));
  const ready = signal(true);
  const destroyed = signal(false);
  let destroyPromise: Promise<void> | undefined;
  let controller = new AbortController();
  const staleController = new AbortController();
  staleController.abort();
  const listeners = new Set<() => void>();
  const mutations = new Set<() => void>();
  const retirements = new Set<Promise<void>>();

  const isCurrent = (captured: ShipQueryScopeSnapshot): boolean => {
    const active = current();
    const enabled = ready();
    const ended = destroyed();
    return (
      !ended &&
      enabled &&
      captured.namespace === active.namespace &&
      captured.scopeKey === active.scopeKey &&
      captured.generation === active.generation
    );
  };

  const register = (
    callbacks: Set<() => void>,
    captured: ShipQueryScopeSnapshot,
    callback: () => void
  ): (() => void) => {
    if (!untracked(() => isCurrent(captured))) {
      callback();
      return () => undefined;
    }
    // Separate registrations remain independent even when they use the same callback.
    const registered = () => callback();
    callbacks.add(registered);
    return () => {
      callbacks.delete(registered);
    };
  };

  const retire = async (
    previous: ShipQueryScopeSnapshot,
    abort: AbortController
  ): Promise<void> => {
    const errors: unknown[] = [];
    const attempt = (action: () => void): void => {
      try {
        action();
      } catch (error: unknown) {
        errors.push(error);
      }
    };
    const oldListeners = [...listeners];
    const oldMutations = [...mutations];
    listeners.clear();
    mutations.clear();
    for (const cleanup of oldListeners) attempt(cleanup);
    attempt(() => abort.abort());
    for (const cancel of oldMutations) attempt(cancel);

    let cancellation: Promise<void> | undefined;
    const filters = {
      predicate: (query: { readonly queryKey: readonly unknown[] }) =>
        isShipQueryScopeKey(query.queryKey, previous),
    };
    attempt(() => {
      cancellation = cache.cancelQueries(filters);
    });
    // Remove immediately. Cancellation can wait on an adapter, but old data must disappear now.
    attempt(() => cache.removeQueries(filters));
    attempt(() => {
      const mutationCache = cache.getMutationCache();
      const oldRecords = mutationCache.findAll({
        predicate: mutation => isShipQueryScopeKey(mutation.options.mutationKey, previous),
      });
      for (const mutation of oldRecords) attempt(() => mutationCache.remove(mutation));
    });
    try {
      await cancellation;
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Ship query scope cleanup failed');
    }
  };

  const retireOwned = (previous: ShipQueryScopeSnapshot, abort: AbortController): Promise<void> => {
    // Register before calling user cleanup: a cleanup can itself replace the identity.
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const retirement = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    retirements.add(retirement);
    const pending = [...retirements];
    void retirement.then(
      () => retirements.delete(retirement),
      () => retirements.delete(retirement)
    );
    void retire(previous, abort).then(resolve, reject);
    return Promise.allSettled(pending).then(results => {
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(result => result.reason),
          'Ship query scope transition failed'
        );
      }
    });
  };

  return {
    capture: () => {
      const active = current();
      if (destroyed()) throw new Error('Ship query scope is destroyed');
      return active;
    },
    isCurrent,
    signal: captured => (isCurrent(captured) ? controller.signal : staleController.signal),
    change: async nextIdentity => {
      if (untracked(destroyed)) throw new Error('Ship query scope is destroyed');
      if (fixed) throw new Error('A fixed ship query scope cannot change identity');
      const previous = untracked(current);
      if (previous.generation >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Ship query scope generation is exhausted');
      }
      const next = snapshot(nextIdentity, previous.generation + 1);
      const previousController = controller;
      ready.set(false);
      current.set(next);
      controller = new AbortController();
      await retireOwned(previous, previousController);
      // An older transition must never re-enable a newer transition or a destroyed scope.
      if (!untracked(destroyed) && untracked(current) === next) ready.set(true);
      return next;
    },
    onCleanup: (captured, cleanup) => register(listeners, captured, cleanup),
    registerMutation: (captured, cancel) => register(mutations, captured, cancel),
    runIfCurrent: (captured, effect) => {
      if (!isCurrent(captured)) return false;
      effect();
      return true;
    },
    destroy: () => {
      if (destroyPromise !== undefined) return destroyPromise;
      destroyed.set(true);
      ready.set(false);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      // Establish idempotence before invoking listeners that might call destroy again.
      destroyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void retireOwned(untracked(current), controller).then(resolve, reject);
      return destroyPromise;
    },
  };
}
