import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, InjectionToken, inject, PLATFORM_ID, type Provider } from '@angular/core';
import {
  createClosedShipRealtime,
  createShipRealtime,
  type ShipRealtimeOptions,
} from './create-ship-realtime';
import type { RealtimeChannelContract } from './realtime-contract';
import type { ShipRealtime } from './realtime-subscription';
import { createSocketIoTransport } from './socket-io-transport';

/**
 * Default token for the application's realtime client.
 *
 * Typed against the open {@link RealtimeChannelContract} because the framework does not
 * own the application's channel types; pass a typed token for a cast-free `inject()`.
 */
export const SHIP_REALTIME = new InjectionToken<ShipRealtime<RealtimeChannelContract>>(
  'SHIP_REALTIME'
);

/**
 * Provide one realtime client per Angular injector.
 *
 * On the server the provider is a no-op: no socket is opened and every subscription is
 * returned already closed, so an SSR render never holds a live gateway link.
 *
 * @example
 * ```ts
 * provideShipRealtime<AppChannels>({
 *   url: env.realtimeUrl,
 *   credential: () => auth.capabilities.bearerToken.getToken(),
 *   manifest: clientManifest,
 * });
 * ```
 */
export function provideShipRealtime<TContract extends RealtimeChannelContract>(
  options: ShipRealtimeOptions<TContract>,
  token: InjectionToken<ShipRealtime<TContract>> = SHIP_REALTIME as unknown as InjectionToken<
    ShipRealtime<TContract>
  >
): Provider {
  return {
    provide: token,
    useFactory: (): ShipRealtime<TContract> => {
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return createClosedShipRealtime<TContract>();
      const client = createShipRealtime<TContract>(
        options,
        options.transport ?? createSocketIoTransport()
      );
      inject(DestroyRef).onDestroy(() => client.close());
      return client;
    },
  };
}

/** Inject the application's realtime client. Pass the same token used to provide it. */
export function injectRealtime<TContract extends RealtimeChannelContract = RealtimeChannelContract>(
  token: InjectionToken<ShipRealtime<TContract>> = SHIP_REALTIME as unknown as InjectionToken<
    ShipRealtime<TContract>
  >
): ShipRealtime<TContract> {
  return inject(token);
}
