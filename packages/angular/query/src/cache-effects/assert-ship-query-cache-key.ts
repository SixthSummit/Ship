import { canonicalizeKeyValue } from '../keys/canonicalize-key-value';
import type { ShipQueryKey, ShipQueryScopeSnapshot } from '../keys/ship-query-key';

/** Detach and validate a complete read key before selecting or writing owned cache data. */
export function assertShipQueryCacheKey(key: unknown, scope: ShipQueryScopeSnapshot): ShipQueryKey {
  const captured = canonicalizeKeyValue(key);
  if (
    !Array.isArray(captured) ||
    captured.length !== 9 ||
    captured[0] !== 'ship-query' ||
    captured[1] !== 1 ||
    captured[2] !== scope.namespace ||
    captured[3] !== scope.scopeKey ||
    captured[4] !== scope.generation ||
    (captured[5] !== 'finite' && captured[5] !== 'infinite') ||
    typeof captured[6] !== 'string' ||
    captured[6].length === 0
  ) {
    throw new TypeError('Cache effects require a complete read key in the captured scope.');
  }
  return captured as unknown as ShipQueryKey;
}
