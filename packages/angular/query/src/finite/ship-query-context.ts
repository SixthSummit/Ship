import type { QueryClient } from '@tanstack/angular-query-experimental';
import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';

/** The owned controller supplies reactive capture and current-generation checks. */
interface ShipQueryReadScope {
  capture(): ShipQueryScopeSnapshot;
  isCurrent(snapshot: ShipQueryScopeSnapshot): boolean;
  signal(snapshot: ShipQueryScopeSnapshot): AbortSignal;
}

/** Structural context shared by browser and request-scoped server queries. */
export interface ShipQueryReadContext {
  readonly queryClient: QueryClient;
  readonly scope: ShipQueryReadScope;
}
