import type { ShipQueryKey } from '../keys/ship-query-key';

/** Explicit read selections. Operation targets include both finite and infinite modes. */
export type ShipQueryInvalidationTarget =
  | { readonly kind: 'exact'; readonly key: ShipQueryKey }
  | { readonly kind: 'operation'; readonly operationId: string };
