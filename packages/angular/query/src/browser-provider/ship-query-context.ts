import type { QueryClient } from '@tanstack/angular-query-experimental';
import type { ShipQueryScopeController } from '../scope/ship-query-scope-controller';

/** Owned cache and identity lifecycle for one application injector. */
export interface ShipQueryContext {
  readonly queryClient: QueryClient;
  readonly scope: ShipQueryScopeController;
}
