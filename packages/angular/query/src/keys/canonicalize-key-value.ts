import type { ShipQueryKeyValue } from './ship-query-key';

/** Copy and freeze JSON values. Reject values that JSON hashing would lose or change. */
export function canonicalizeKeyValue(value: unknown): ShipQueryKeyValue {
  const ancestors = new Set<object>();

  function visit(current: unknown): ShipQueryKeyValue {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object' || current === null) {
      throw new TypeError('Query key values must be finite JSON values.');
    }
    if (ancestors.has(current)) {
      throw new TypeError('Query key values must not contain cycles.');
    }
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Query key objects must be plain JSON objects.');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.some(
            key =>
              key !== 'length' &&
              (typeof key !== 'string' ||
                !/^(0|[1-9]\d*)$/.test(key) ||
                Number(key) >= current.length)
          )
        ) {
          throw new TypeError('Query key arrays must not contain custom properties.');
        }
        const copy: ShipQueryKeyValue[] = [];
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Query key arrays must not contain holes or accessors.');
          }
          copy.push(visit(descriptor.value));
        }
        return Object.freeze(copy);
      }
      const copy: Record<string, ShipQueryKeyValue> = {};
      const keys = Reflect.ownKeys(current);
      if (keys.some(key => typeof key !== 'string')) {
        throw new TypeError('Query key objects must not contain symbol properties.');
      }
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('Query key objects must contain enumerable data properties.');
        }
        Object.defineProperty(copy, key, {
          value: visit(descriptor.value),
          enumerable: true,
        });
      }
      return Object.freeze(copy);
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value);
}
