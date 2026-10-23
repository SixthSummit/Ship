import { InjectionToken, inject, type Provider } from '@angular/core';
import { ShipCredentialAuth, type ShipCredentialAuthOptions } from './ship-credential-auth';

export const SHIP_CREDENTIAL_AUTH = new InjectionToken<ShipCredentialAuth>('SHIP_CREDENTIAL_AUTH');

/**
 * Provide the credential-auth client once per injector. `client` is the
 * application's operation client or a factory that runs in the injection
 * context, so it can `inject()` the application's own token.
 *
 * @example
 * ```ts
 * provideShipCredentialAuth({ client: () => injectShipClient(APP_CLIENT), storage: browserSessionStorage() });
 * ```
 */
export function provideShipCredentialAuth(options: ShipCredentialAuthOptions): Provider {
  return {
    provide: SHIP_CREDENTIAL_AUTH,
    useFactory: (): ShipCredentialAuth => {
      const client = typeof options.client === 'function' ? options.client() : options.client;
      return new ShipCredentialAuth({ ...options, client });
    },
  };
}

export function injectCredentialAuth(): ShipCredentialAuth {
  return inject(SHIP_CREDENTIAL_AUTH);
}
