import type { ShipQueryScopeSnapshot } from '../scope/ship-query-scope-snapshot';

/** Use run at the actual cache write, including after each await in an application callback. */
export interface ShipMutationEffects {
  readonly scope: ShipQueryScopeSnapshot;
  isCurrent(): boolean;
  run(effect: () => void): boolean;
}
