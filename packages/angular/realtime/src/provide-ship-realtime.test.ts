import {
  createEnvironmentInjector,
  EnvironmentInjector,
  PLATFORM_ID,
  provideZonelessChangeDetection,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { injectRealtime, provideShipRealtime, SHIP_REALTIME } from './provide-ship-realtime';
import type { RealtimeManifest } from './realtime-contract';
import type { ShipRealtimeConnection, ShipRealtimeTransport } from './realtime-transport';

interface TestChannels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly balance: number };
      readonly presence: false;
    };
  };
}

const MANIFEST: RealtimeManifest<TestChannels> = {
  channels: { 'account.updated': { scope: 'actor', payload: 'AccountUpdated', presence: false } },
};

function countingTransport(): { transport: ShipRealtimeTransport; connects: () => number } {
  let connects = 0;
  const transport: ShipRealtimeTransport = async () => {
    connects += 1;
    const link: ShipRealtimeConnection = {
      subscribe: async () => ({ ok: true, subscriptionId: 'subscription-1' }),
      unsubscribe: async () => ({ ok: true }),
      presenceSnapshot: async () => ({ ok: true, count: 0, members: [] }),
      close: () => undefined,
    };
    return link;
  };
  return { transport, connects: () => connects };
}

describe('provideShipRealtime', () => {
  it('provides a browser client through the default token', async () => {
    const { transport, connects } = countingTransport();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideShipRealtime<TestChannels>({
          url: 'https://gateway.test',
          credential: () => 'token',
          manifest: MANIFEST,
          transport,
        }),
      ],
    });

    const client = TestBed.runInInjectionContext(() => injectRealtime<TestChannels>());
    expect(client).toBe(TestBed.inject(SHIP_REALTIME));

    const subscription = client.subscribe('account.updated', 'actor-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscription.status()).toBe('active');
    expect(connects()).toBe(1);
  });

  it('is a no-op during server-side rendering', async () => {
    const { transport, connects } = countingTransport();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: 'server' },
        provideShipRealtime<TestChannels>({
          url: 'https://gateway.test',
          credential: () => 'token',
          manifest: MANIFEST,
          transport,
        }),
      ],
    });

    const client = TestBed.runInInjectionContext(() => injectRealtime<TestChannels>());
    const subscription = client.subscribe('account.updated', 'actor-1');
    const stop = subscription.events(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(client.status()).toBe('closed');
    expect(subscription.status()).toBe('closed');
    expect(subscription.latest()).toBeUndefined();
    expect(subscription.dropped()).toBe(0);
    expect(subscription.error()).toBeUndefined();
    expect(connects()).toBe(0);
    expect(() => {
      stop();
      subscription.unsubscribe();
      client.close();
    }).not.toThrow();
  });

  it('closes the client when its injector is destroyed', async () => {
    const { transport } = countingTransport();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const child = createEnvironmentInjector(
      [
        provideShipRealtime<TestChannels>({
          url: 'https://gateway.test',
          credential: () => 'token',
          manifest: MANIFEST,
          transport,
        }),
      ],
      TestBed.inject(EnvironmentInjector)
    );
    const client = child.get(SHIP_REALTIME);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscription.status()).toBe('active');

    child.destroy();

    expect(client.status()).toBe('closed');
    expect(subscription.status()).toBe('closed');
  });
});
