import {
  type HttpOperationId,
  OperationApiError,
  type OperationDataOf,
  type OperationResultOf,
  type OperationSuccessOf,
  ProtocolError,
} from '@sixthsummit/ship-angular/operations';
import type { ShipQueryEnvelope } from './ship-query-envelope';

/** Convert expected failures only at the Query boundary. Preserve the original result. */
export function adaptReadResult<TContract extends object, TId extends HttpOperationId<TContract>>(
  result: OperationResultOf<TContract, TId>,
  previous?: ShipQueryEnvelope<TContract, TId>
): ShipQueryEnvelope<TContract, TId> {
  if (!result.ok) throw new OperationApiError(result);
  if (result.notModified === true) {
    if (previous === undefined) {
      throw new ProtocolError('Received 304 without a cached operation value', {
        reason: 'unexpected-status',
        status: result.status,
        metadata: result.headers,
      });
    }
    const etag = result.headers.etag ?? previous.etag;
    return {
      data: previous.data,
      result: result as OperationSuccessOf<TContract, TId>,
      ...(etag === undefined ? {} : { etag }),
    };
  }
  const etag = result.headers.etag;
  return {
    data: result.data as OperationDataOf<TContract, TId>,
    result: result as OperationSuccessOf<TContract, TId>,
    ...(etag === undefined ? {} : { etag }),
  };
}
