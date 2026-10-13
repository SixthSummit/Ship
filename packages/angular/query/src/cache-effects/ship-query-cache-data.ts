import type { OperationNotModified, OperationSuccess } from '@sixthsummit/ship-angular/operations';

/** Common envelope shape. Tagged query keys retain their precise operation body and result types. */
export interface ShipQueryCacheEnvelope {
  readonly data: unknown;
  readonly result: OperationSuccess<unknown> | OperationNotModified;
  readonly etag?: string;
}

export type ShipQueryCacheData =
  | ShipQueryCacheEnvelope
  | {
      readonly pages: readonly ShipQueryCacheEnvelope[];
      readonly pageParams: readonly unknown[];
    };
