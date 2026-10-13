/** Supported application defaults. The operation policy owns all retry attempts. */
export interface ShipQueryFreshness {
  readonly staleTime?: number;
  readonly gcTime?: number;
  readonly refetchOnMount?: boolean | 'always';
  readonly refetchOnWindowFocus?: boolean | 'always';
  readonly refetchOnReconnect?: boolean | 'always';
}

export interface ShipQueryConfig {
  readonly namespace: string;
  /** Non-secret application identity and tenant key. */
  readonly scopeKey: string;
  readonly freshness?: ShipQueryFreshness;
}
