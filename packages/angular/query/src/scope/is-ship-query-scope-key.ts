import type { ShipQueryScopeSnapshot } from './ship-query-scope-snapshot';

/** Match only the versioned owned key prefix, for query keys and mutation keys alike. */
export function isShipQueryScopeKey(
  key: readonly unknown[] | undefined,
  scope: ShipQueryScopeSnapshot
): boolean {
  return (
    Array.isArray(key) &&
    key[0] === 'ship-query' &&
    key[1] === 1 &&
    key[2] === scope.namespace &&
    key[3] === scope.scopeKey &&
    key[4] === scope.generation
  );
}
