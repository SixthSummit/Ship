import type {
  HttpOperationId,
  OperationDataOf,
  OperationSuccessOf,
} from '@sixthsummit/ship-angular/operations';

/** A complete operation response plus the body retained for a conditional read. */
export interface ShipQueryEnvelope<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
> {
  readonly data: OperationDataOf<TContract, TId>;
  readonly result: OperationSuccessOf<TContract, TId>;
  readonly etag?: string;
}
