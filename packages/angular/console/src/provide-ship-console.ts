import { InjectionToken, inject, type Provider } from '@angular/core';
import { ShipConsole, type ShipConsoleOptions } from './ship-console';

export const SHIP_CONSOLE = new InjectionToken<ShipConsole>('SHIP_CONSOLE');

/**
 * Provide the console client once per injector. The `client` option takes the
 * application's operation client, or a factory that runs in the injection
 * context so it can `inject()` the application's own token.
 *
 * @example
 * ```ts
 * provideShipConsole({ client: () => injectShipClient(APP_CLIENT) });
 * ```
 */
export function provideShipConsole(options: ShipConsoleOptions): Provider {
  return {
    provide: SHIP_CONSOLE,
    useFactory: (): ShipConsole => {
      const client = typeof options.client === 'function' ? options.client() : options.client;
      return new ShipConsole({ ...options, client });
    },
  };
}

export function injectConsole(): ShipConsole {
  return inject(SHIP_CONSOLE);
}
