import type { OperationCallOptions } from '@sixthsummit/ship-angular/operations';

/** Capture mutable caller header containers before asynchronous operation work begins. */
export function copyShipMutationCall(options: OperationCallOptions): OperationCallOptions {
  return {
    ...options,
    ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
  };
}
