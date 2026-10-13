import { type InjectionToken, inject, PLATFORM_ID, type Provider, REQUEST } from '@angular/core';
import type { OperationClient } from './operation-client';
import {
  createShipClientContext,
  type ShipClientContext,
  type ShipClientContextConfig,
} from './ship-client-context';

export type ShipClientFactory<TContract extends object> = (
  context: ShipClientContext
) => OperationClient<TContract>;

/**
 * Provide one application-typed client per Angular injector.
 *
 * Angular SSR creates a request injector for each render, so the resulting client and
 * its sanitized context cannot retain another user's cookies or cancellation signal.
 */
export function provideShipClient<TContract extends object>(
  token: InjectionToken<OperationClient<TContract>>,
  factory: ShipClientFactory<TContract>,
  config: ShipClientContextConfig
): Provider {
  return {
    provide: token,
    useFactory: () => {
      const platformId = inject(PLATFORM_ID);
      const request = inject(REQUEST, { optional: true }) ?? null;
      return factory(createShipClientContext(platformId, request, config));
    },
  };
}
