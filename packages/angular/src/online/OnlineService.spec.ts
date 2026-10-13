import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineService } from './OnlineService';

const setup = () => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  return TestBed.inject(OnlineService);
};

const flush = (n = 4) =>
  Array.from({ length: n }, () => new Promise<void>(r => setTimeout(r, 0))).reduce(
    (p, q) => p.then(() => q),
    Promise.resolve()
  );

describe('OnlineService — navigator.onLine wiring', () => {
  it('initial online() reads navigator.onLine', () => {
    const svc = setup();
    expect(svc.online()).toBe(navigator.onLine);
  });

  it('flips to false on the offline event', () => {
    const svc = setup();
    window.dispatchEvent(new Event('offline'));
    expect(svc.online()).toBe(false);
  });

  it('flips to true on the online event (when health is ok)', () => {
    const svc = setup();
    window.dispatchEvent(new Event('offline'));
    expect(svc.online()).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(svc.online()).toBe(true);
  });
});

describe('OnlineService — health polling', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('runs a probe on startPolling and reflects 200 → true', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    svc.startPolling({ url: '/healthz', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(svc.online()).toBe(true);
    svc.stopPolling();
  });

  it('reflects non-OK response as offline', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    svc.startPolling({ url: '/healthz', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    expect(svc.online()).toBe(false);
    svc.stopPolling();
  });

  it('reflects fetch rejection as offline', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('net'));
    svc.startPolling({ url: '/healthz', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    expect(svc.online()).toBe(false);
    svc.stopPolling();
  });

  it('probe() runs a one-shot manual probe', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await svc.probe({ url: '/healthz', fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(svc.online()).toBe(true);
  });

  it('startPolling is idempotent — calling twice replaces the previous interval', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    svc.startPolling({ url: '/a', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    svc.startPolling({ url: '/b', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    // Both immediate probes executed
    expect(fetchImpl.mock.calls.map(c => c[0])).toContain('/a');
    expect(fetchImpl.mock.calls.map(c => c[0])).toContain('/b');
    svc.stopPolling();
  });

  it('stopPolling cancels future probes', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    svc.startPolling({ url: '/healthz', intervalMs: 50, fetch: fetchImpl });
    await flush();
    const callsBefore = fetchImpl.mock.calls.length;
    svc.stopPolling();
    // Wait > interval to be sure no further probe fires.
    await new Promise(r => setTimeout(r, 150));
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });
});

describe('OnlineService — combined state', () => {
  it('online()=false when navigator is offline even if health is ok', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    svc.startPolling({ url: '/healthz', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    expect(svc.online()).toBe(true);
    window.dispatchEvent(new Event('offline'));
    expect(svc.online()).toBe(false);
    svc.stopPolling();
  });

  it('online()=false when health is down even if navigator is online', async () => {
    const svc = setup();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('down', { status: 503 }));
    svc.startPolling({ url: '/healthz', intervalMs: 60_000, fetch: fetchImpl });
    await flush();
    expect(svc.online()).toBe(false);
    svc.stopPolling();
  });
});
