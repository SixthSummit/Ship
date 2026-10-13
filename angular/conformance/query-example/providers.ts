import { provideShipQuery, provideShipQueryServer } from '@sixthsummit/ship-angular/query';

export const browserQueryProviders = [
  provideShipQuery({ namespace: 'example.v1', scopeKey: 'anonymous' }),
];

/** Invoke for each SSR request injector. Never retain the returned injector across requests. */
export function requestQueryProviders(nonSecretRequestScopeKey: string) {
  return [provideShipQueryServer({ namespace: 'example.v1', scopeKey: nonSecretRequestScopeKey })];
}
