import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, InjectionToken, inject, PLATFORM_ID, type Provider } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import type { ShipPushOptions } from './push-subscription';
import { ShipPush } from './ship-push';

export const SHIP_PUSH = new InjectionToken<ShipPush>('SHIP_PUSH');

/** Requires Angular's provideServiceWorker in the consuming app. SSR never resolves browser capabilities. */
export function provideShipPush(options: ShipPushOptions | (() => ShipPushOptions)): Provider {
  return {
    provide: SHIP_PUSH,
    useFactory: (): ShipPush => {
      const browser = isPlatformBrowser(inject(PLATFORM_ID));
      const client = new ShipPush(
        browser ? inject(SwPush, { optional: true }) : null,
        typeof options === 'function' ? options() : options
      );
      inject(DestroyRef).onDestroy(() => client.destroy());
      return client;
    },
  };
}

export function injectPush(): ShipPush {
  return inject(SHIP_PUSH);
}
