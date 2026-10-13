import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';

/** Observer-only selection. QueryClient continues to cache the operation envelope. */
export interface ScopedQueryValue<TData> {
  readonly scope: ShipQueryScopeSnapshot;
  readonly value: TData;
}
