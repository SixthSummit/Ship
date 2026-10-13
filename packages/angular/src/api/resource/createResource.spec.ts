import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { createResource } from './createResource';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('createResource — URL overload', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    return TestBed.inject(HttpTestingController);
  }

  it('loads a value from a string URL', async () => {
    const httpMock = setup();
    const r = TestBed.runInInjectionContext(() => createResource<{ id: number }[]>('/api/items'));
    await flush();
    httpMock.expectOne('/api/items').flush([{ id: 1 }]);
    await flush();
    expect(r.value()).toEqual([{ id: 1 }]);
    httpMock.verify();
  });

  it('loads from a URL factory', async () => {
    const httpMock = setup();
    const r = TestBed.runInInjectionContext(() => createResource<string>(() => '/api/x'));
    await flush();
    httpMock.expectOne('/api/x').flush('hi');
    await flush();
    expect(r.value()).toBe('hi');
    httpMock.verify();
  });

  it('reload() refetches', async () => {
    const httpMock = setup();
    const r = TestBed.runInInjectionContext(() => createResource<number>('/api/n'));
    await flush();
    httpMock.expectOne('/api/n').flush(1);
    await flush();
    expect(r.value()).toBe(1);

    r.reload();
    await flush();
    httpMock.expectOne('/api/n').flush(2);
    await flush();
    expect(r.value()).toBe(2);
    httpMock.verify();
  });

  it('passes method, body, and headers from options', async () => {
    const httpMock = setup();
    TestBed.runInInjectionContext(() =>
      createResource<unknown>('/api/post', {
        method: 'POST',
        body: { a: 1 },
        headers: { 'X-Custom': 'v' },
      })
    );
    await flush();
    const req = httpMock.expectOne('/api/post');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ a: 1 });
    expect(req.request.headers.get('X-Custom')).toBe('v');
    req.flush({ ok: true });
    httpMock.verify();
  });
});

describe('createResource — ETag opt-in', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    return TestBed.inject(HttpTestingController);
  }

  it('does NOT send If-None-Match when no etag has been received yet', async () => {
    const httpMock = setup();
    TestBed.runInInjectionContext(() =>
      createResource<unknown>('/api/x', { cache: { etag: true } })
    );
    await flush();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.has('If-None-Match')).toBe(false);
    req.flush({ ok: true }, { headers: { ETag: 'v1' } });
    httpMock.verify();
  });

  it('sends If-None-Match on reload after receiving an ETag', async () => {
    const httpMock = setup();
    const r = TestBed.runInInjectionContext(() =>
      createResource<{ ok: boolean }>('/api/x', { cache: { etag: true } })
    );
    await flush();
    httpMock.expectOne('/api/x').flush({ ok: true }, { headers: { ETag: 'v1' } });
    await flush();
    expect(r.value()).toEqual({ ok: true });

    r.reload();
    await flush();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('If-None-Match')).toBe('v1');
    req.flush({ ok: true, fresh: true }, { headers: { ETag: 'v2' } });
    await flush();
    expect(r.value()).toEqual({ ok: true, fresh: true });
    httpMock.verify();
  });

  it('on 304 reuses the cached value without changing the signal payload', async () => {
    const httpMock = setup();
    const r = TestBed.runInInjectionContext(() =>
      createResource<{ ok: boolean }>('/api/x', { cache: { etag: true } })
    );
    await flush();
    httpMock.expectOne('/api/x').flush({ ok: true }, { headers: { ETag: 'v1' } });
    await flush();
    const firstValue = r.value();

    r.reload();
    await flush();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('If-None-Match')).toBe('v1');
    req.flush(null, { status: 304, statusText: 'Not Modified' });
    await flush();
    expect(r.value()).toEqual(firstValue);
    httpMock.verify();
  });

  it('cache is keyed by URL — distinct URLs do not share entries', async () => {
    const httpMock = setup();
    const a = TestBed.runInInjectionContext(() =>
      createResource<{ from: string }>('/api/a', { cache: { etag: true } })
    );
    await flush();
    httpMock.expectOne('/api/a').flush({ from: 'a' }, { headers: { ETag: 'va' } });
    await flush();
    expect(a.value()).toEqual({ from: 'a' });

    const b = TestBed.runInInjectionContext(() =>
      createResource<{ from: string }>('/api/b', { cache: { etag: true } })
    );
    await flush();
    const reqB = httpMock.expectOne('/api/b');
    expect(reqB.request.headers.has('If-None-Match')).toBe(false);
    reqB.flush({ from: 'b' }, { headers: { ETag: 'vb' } });
    await flush();
    expect(b.value()).toEqual({ from: 'b' });
    httpMock.verify();
  });
});

describe('createResource — thunk overload', () => {
  function setupNoHttp() {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  }

  it('resolves the value returned by an async thunk', async () => {
    setupNoHttp();
    const r = TestBed.runInInjectionContext(() =>
      createResource<{ x: number }>(async () => ({ x: 42 }))
    );
    await flush();
    await flush();
    expect(r.value()).toEqual({ x: 42 });
  });

  it('reuses the eagerly-invoked first Promise as the initial load', async () => {
    setupNoHttp();
    let calls = 0;
    const r = TestBed.runInInjectionContext(() =>
      createResource<number>(async () => {
        calls++;
        return calls;
      })
    );
    await flush();
    await flush();
    // The thunk runs once eagerly during construction (the probe). The
    // loader reuses that probe Promise as the first load. Total: 1 call.
    expect(calls).toBe(1);
    expect(r.value()).toBe(1);
  });

  it('reload() invokes the thunk again', async () => {
    setupNoHttp();
    let calls = 0;
    const r = TestBed.runInInjectionContext(() =>
      createResource<number>(async () => {
        calls++;
        return calls;
      })
    );
    await flush();
    await flush();
    expect(r.value()).toBe(1);

    r.reload();
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(r.value()).toBe(2);
  });

  it('errors thrown from the thunk surface on error() and status() reflects error state', async () => {
    setupNoHttp();
    const boom = new Error('boom');
    const r = TestBed.runInInjectionContext(() =>
      createResource<number>(async () => {
        throw boom;
      })
    );
    await flush();
    await flush();
    expect(r.error()).toBe(boom);
    // status() reflects error state — value() throws when read in error state
    // (Angular's resource() contract), so callers gate on status / error first.
    expect(String(r.status())).toMatch(/error/i);
  });

  it('also accepts a non-async function that returns a Promise', async () => {
    setupNoHttp();
    const r = TestBed.runInInjectionContext(() =>
      createResource<string>(() => Promise.resolve('hi'))
    );
    await flush();
    await flush();
    expect(r.value()).toBe('hi');
  });

  it('throws synchronously when source returns an unsupported type', () => {
    setupNoHttp();
    expect(() =>
      // @ts-expect-error testing the runtime guard
      TestBed.runInInjectionContext(() => createResource(() => 42))
    ).toThrow(/source must be/);
  });
});
