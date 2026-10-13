import type { ShipQueryScopeSnapshot } from '../keys/ship-query-key';

/** Observer errors carry identity. Public signals expose the original failure. */
export class ScopedQueryError extends Error {
  readonly scope: ShipQueryScopeSnapshot;
  readonly original: unknown;

  constructor(scope: ShipQueryScopeSnapshot, original: unknown) {
    super('Scoped query failed');
    this.name = 'ScopedQueryError';
    this.scope = scope;
    this.original = original;
  }
}
