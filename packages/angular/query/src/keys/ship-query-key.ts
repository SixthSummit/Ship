/** Values allowed in cache keys. Credentials must never appear in these values. */
export type ShipQueryKeyValue =
  | null
  | string
  | number
  | boolean
  | readonly ShipQueryKeyValue[]
  | { readonly [key: string]: ShipQueryKeyValue };

export type ShipQueryMode = 'finite' | 'infinite';

/** Immutable identity boundary captured before a query starts. */
export interface ShipQueryScopeSnapshot {
  readonly namespace: string;
  readonly scopeKey: string;
  readonly generation: number;
}

export type ShipQueryKey = readonly [
  'ship-query',
  1,
  string,
  string,
  number,
  ShipQueryMode,
  string,
  ShipQueryKeyValue,
  ShipQueryKeyValue,
];
