import type { InferDataFromTag } from '@tanstack/angular-query-experimental';
import type { ShipQueryContext } from '../browser-provider/ship-query-context';
import type { ShipQueryKey, ShipQueryScopeSnapshot } from '../keys/ship-query-key';
import { assertShipQueryCacheData } from './assert-ship-query-cache-data';
import { assertShipQueryCacheKey } from './assert-ship-query-cache-key';
import type { ShipQueryCacheData } from './ship-query-cache-data';

/** Update an explicit owned key. Use a pure synchronous updater; undefined skips the write. */
export function updateShipQueryData<
  TData extends ShipQueryCacheData = ShipQueryCacheData,
  TKey extends ShipQueryKey = ShipQueryKey,
>(
  context: ShipQueryContext,
  key: TKey & (InferDataFromTag<TData, TKey> extends ShipQueryCacheData ? unknown : never),
  updater: (
    previous: NoInfer<InferDataFromTag<TData, TKey>> | undefined
  ) => NoInfer<InferDataFromTag<TData, TKey>> | undefined,
  capturedScope: ShipQueryScopeSnapshot
): InferDataFromTag<TData, TKey> | undefined {
  if (!context.scope.isCurrent(capturedScope)) return undefined;
  const capturedKey = assertShipQueryCacheKey(key, capturedScope);
  const result = context.queryClient.setQueryData<InferDataFromTag<TData, TKey>>(
    capturedKey,
    previous => {
      if (!context.scope.isCurrent(capturedScope)) return undefined;
      if (previous !== undefined) assertShipQueryCacheData(previous, capturedKey[5]);
      if (!context.scope.isCurrent(capturedScope)) return undefined;
      const next = updater(previous);
      if (!context.scope.isCurrent(capturedScope)) return undefined;
      if (next !== undefined) assertShipQueryCacheData(next, capturedKey[5]);
      return context.scope.isCurrent(capturedScope) ? next : undefined;
    }
  );
  return context.scope.isCurrent(capturedScope) ? result : undefined;
}
