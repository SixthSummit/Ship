import { hashKey } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import { assertShipQueryCacheKey } from './assert-ship-query-cache-key';
import type { ShipQueryInvalidationTarget } from './ship-query-invalidation-target';

/** Invalidate selected reads only. A false result means that the captured scope became stale. */
export async function invalidateShipQueries(
  context: ShipQueryContext,
  targets: readonly ShipQueryInvalidationTarget[],
  capturedScope: ShipQueryScopeSnapshot
): Promise<boolean> {
  if (!context.scope.isCurrent(capturedScope)) return false;
  if (!Array.isArray(targets)) throw new TypeError('Query invalidation requires explicit targets.');
  const exact = new Set<string>();
  const operations = new Set<string>();
  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      throw new TypeError('Query invalidation requires explicit exact or operation targets.');
    }
    if (target.kind === 'exact') {
      exact.add(hashKey(assertShipQueryCacheKey(target.key, capturedScope)));
    } else if (
      target.kind === 'operation' &&
      typeof target.operationId === 'string' &&
      target.operationId.length > 0
    ) {
      operations.add(target.operationId);
    } else {
      throw new TypeError('Query invalidation requires explicit exact or operation targets.');
    }
  }
  if (!context.scope.isCurrent(capturedScope)) return false;
  if (exact.size === 0 && operations.size === 0) return true;
  await context.queryClient.invalidateQueries({
    predicate: query => {
      if (!context.scope.isCurrent(capturedScope)) return false;
      try {
        const key = assertShipQueryCacheKey(query.queryKey, capturedScope);
        return operations.has(key[6]) || exact.has(hashKey(key));
      } catch {
        // Unrelated native queries and non-read records never become implicit targets.
        return false;
      }
    },
  });
  return context.scope.isCurrent(capturedScope);
}
