/** Angular-owned DI boundary for the generated, browser-safe ShipAPI contract. */
import { inject, InjectionToken, type Provider } from '@angular/core';
import {
  createShipClientToken,
  injectShipClient,
  type OperationClient,
  type OperationRequestPolicy,
  provideShipOperationBoundary,
  type ShipOperationBoundaryFactory,
} from '@sixthsummit/ship-angular/operations';
import type { <%= contractType %> } from '<%= contractPackage %>';
<%= baseUrlImport %>

export const APP_SHIP_CLIENT = createShipClientToken<<%= contractType %>>('APP_SHIP_CLIENT');
export const APP_SHIP_REQUEST_POLICY = new InjectionToken<OperationRequestPolicy<<%= contractType %>>>(
  'APP_SHIP_REQUEST_POLICY'
);

export type AppShipClient = OperationClient<<%= contractType %>>;
export type AppShipClientFactory = ShipOperationBoundaryFactory<<%= contractType %>>;

export function provideAppShipClient(factory: AppShipClientFactory): readonly Provider[] {
  return provideShipOperationBoundary(APP_SHIP_CLIENT, APP_SHIP_REQUEST_POLICY, factory, {
    apiBaseUrl: <%= baseUrlExpression %>,
    forwarding: {
      cookieNames: <%= cookieNames %>,
      headerNames: <%= headerNames %>,
    },
  });
}

export function injectAppShipClient(): AppShipClient {
  return injectShipClient(APP_SHIP_CLIENT);
}

export function injectAppShipRequestPolicy(): OperationRequestPolicy<<%= contractType %>> {
  return inject(APP_SHIP_REQUEST_POLICY);
}
