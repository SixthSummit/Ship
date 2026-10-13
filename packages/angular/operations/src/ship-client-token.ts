import { InjectionToken, inject } from '@angular/core';
import type { OperationClient } from './operation-client';

/** Create an application-typed operation-client token with no global cast. */
export function createShipClientToken<TContract extends object>(
  description = 'SHIP_OPERATION_CLIENT'
): InjectionToken<OperationClient<TContract>> {
  return new InjectionToken<OperationClient<TContract>>(description);
}

/** Typed convenience wrapper around Angular's inject(). */
export function injectShipClient<TContract extends object>(
  token: InjectionToken<OperationClient<TContract>>
): OperationClient<TContract> {
  return inject(token);
}
