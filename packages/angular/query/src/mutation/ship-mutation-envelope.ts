import type {
  HttpOperationId,
  OperationDataOf,
  OperationDataSuccessOf,
} from '@sixthsummit/ship-angular/operations';

/** A confirmed mutation success. Unlike read envelopes, mutations cannot contain a 304. */
export interface ShipMutationEnvelope<C extends object, I extends HttpOperationId<C>> {
  readonly data: OperationDataOf<C, I>;
  readonly result: OperationDataSuccessOf<C, I>;
  readonly etag?: string;
}
