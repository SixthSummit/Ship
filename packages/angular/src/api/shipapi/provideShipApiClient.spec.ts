import {
  InjectionToken,
  inject,
  type Provider,
  provideZonelessChangeDetection,
  REQUEST,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  injectShipApiClient,
  provideShipApiClient,
  SHIP_API_CLIENT,
  type ShipApiClientFactory,
} from './provideShipApiClient';

interface FakeApi {
  hello(): string;
  __req: Request | null;
}

const buildClient: ShipApiClientFactory<FakeApi> = req => ({
  hello: () => 'hi',
  __req: req,
});

const withProviders = (extra: Provider[] = []): TestBed => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), ...extra],
  });
  return TestBed;
};

describe('provideShipApiClient', () => {
  it('provides the factory result on the default SHIP_API_CLIENT token', () => {
    withProviders([provideShipApiClient(buildClient)]);
    const api = TestBed.inject(SHIP_API_CLIENT) as FakeApi;
    expect(api.hello()).toBe('hi');
    expect(api.__req).toBeNull();
  });

  it('binds to a custom token when one is provided', () => {
    const API = new InjectionToken<FakeApi>('API');
    withProviders([provideShipApiClient(buildClient, API)]);
    const api = TestBed.inject(API);
    expect(api.hello()).toBe('hi');
  });

  it('passes the SSR Request to the factory when one is in the injector', () => {
    const fakeReq = new Request('https://example.test/x', {
      headers: { cookie: 'sid=abc' },
    });
    withProviders([{ provide: REQUEST, useValue: fakeReq }, provideShipApiClient(buildClient)]);
    const api = TestBed.inject(SHIP_API_CLIENT) as FakeApi;
    expect(api.__req).toBe(fakeReq);
    expect(api.__req?.headers.get('cookie')).toBe('sid=abc');
  });

  it('passes null when the SSR Request is provided as null', () => {
    withProviders([{ provide: REQUEST, useValue: null }, provideShipApiClient(buildClient)]);
    const api = TestBed.inject(SHIP_API_CLIENT) as FakeApi;
    expect(api.__req).toBeNull();
  });
});

describe('injectShipApiClient', () => {
  it('returns the value at the default token', () => {
    withProviders([provideShipApiClient(buildClient)]);
    const value = TestBed.runInInjectionContext(() => injectShipApiClient<FakeApi>());
    expect(value.hello()).toBe('hi');
  });

  it('returns the value at a custom token', () => {
    const API = new InjectionToken<FakeApi>('API');
    withProviders([provideShipApiClient(buildClient, API)]);
    const value = TestBed.runInInjectionContext(() => injectShipApiClient<FakeApi>(API));
    expect(value.hello()).toBe('hi');
  });

  it('participates in the standard injection chain', () => {
    withProviders([provideShipApiClient(buildClient)]);
    const value = TestBed.runInInjectionContext(() => {
      // Standard inject() also works — convenience helper just sugars it.
      return inject(SHIP_API_CLIENT) as FakeApi;
    });
    expect(value.hello()).toBe('hi');
  });
});
