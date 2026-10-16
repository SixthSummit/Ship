import '@angular/compiler';
import { provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { provideShipPush, SHIP_PUSH, type ShipPush } from '@sixthsummit/ship-angular/push';

declare global {
  var shipPushBrowser: ShipPush;
}

const app = await createApplication({
  providers: [
    provideZonelessChangeDetection(),
    provideServiceWorker('ngsw-worker.js', {
      enabled: true,
      registrationStrategy: 'registerImmediately',
    }),
    provideShipPush({
      serverPublicKey: 'unused-until-user-subscribes',
      saveSubscription: async () => {
        throw new Error('must not persist without explicit opt-in');
      },
      removeSubscription: async () => {
        throw new Error('must not remove without explicit opt-out');
      },
    }),
  ],
});
globalThis.shipPushBrowser = app.injector.get(SHIP_PUSH);
