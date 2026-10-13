import type { QueryClient } from '@tanstack/angular-query-experimental';

/** The lifecycle uses only the owned cache operations; it never clears the whole client. */
export type ShipQueryScopeCache = Pick<
  QueryClient,
  'cancelQueries' | 'removeQueries' | 'getMutationCache'
>;

export interface ShipQueryScopeConfig {
  readonly namespace: string;
  /** Non-secret application identity and tenant key, never a credential or live auth object. */
  readonly scopeKey: string;
  readonly cache: ShipQueryScopeCache;
  /** Fixed scopes are used by SSR request providers. */
  readonly fixed?: boolean;
}
