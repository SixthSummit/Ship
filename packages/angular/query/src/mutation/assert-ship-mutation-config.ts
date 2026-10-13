import type { HttpOperationId } from '@sixthsummit/ship-angular/operations';
import type { ShipMutationConfig } from './ship-mutation-config';

/** Reject forbidden native options even when the caller bypasses TypeScript. */
export function assertShipMutationConfig<C extends object, I extends HttpOperationId<C>, S>(
  config: ShipMutationConfig<C, I, S>
): void {
  const allowed = new Set(['call', 'concurrency', 'gcTime', 'optimistic', 'onSuccess']);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Ship mutation configuration must be an object');
  }
  for (const key of Reflect.ownKeys(config)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('Ship mutation configuration contains a forbidden override');
    }
  }
  if (
    config.concurrency !== undefined &&
    config.concurrency !== 'reject' &&
    config.concurrency !== 'take-latest'
  ) {
    throw new TypeError('Invalid ship mutation concurrency');
  }
  if (
    config.gcTime !== undefined &&
    (typeof config.gcTime !== 'number' || Number.isNaN(config.gcTime) || config.gcTime < 0)
  ) {
    throw new TypeError('Ship mutation gcTime must be non-negative');
  }
  if (config.onSuccess !== undefined && typeof config.onSuccess !== 'function') {
    throw new TypeError('Ship mutation onSuccess must be a function');
  }
  if (
    config.optimistic !== undefined &&
    (!config.optimistic ||
      typeof config.optimistic.apply !== 'function' ||
      typeof config.optimistic.rollback !== 'function' ||
      (config.optimistic.reconcile !== undefined &&
        typeof config.optimistic.reconcile !== 'function'))
  ) {
    throw new TypeError('Ship mutation optimistic policy is invalid');
  }
}
