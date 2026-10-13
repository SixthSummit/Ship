import type { OperationFailure } from './operation-result';
import type { ResponseMetadata } from './response-metadata';
import type { ShipError } from './ship-error';

/** Presentation-friendly exception adapter for a failed operation result. */
export class OperationApiError<TCode extends string = string> extends Error {
  readonly name = 'OperationApiError';
  readonly code: string;
  readonly declared: boolean;
  readonly status: number;
  readonly details: unknown;
  readonly requestId?: string;
  readonly headers: ResponseMetadata;
  readonly error: ShipError<TCode>;

  constructor(failure: OperationFailure<TCode>) {
    super(failure.error.message);
    this.code = failure.error.code;
    this.declared = failure.error.declared;
    this.status = failure.status;
    this.details = failure.error.details;
    const requestId = failure.error.requestId ?? failure.headers.requestId;
    if (requestId !== undefined) this.requestId = requestId;
    this.headers = failure.headers;
    this.error = failure.error;
  }
}
