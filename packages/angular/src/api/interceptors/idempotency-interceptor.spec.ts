import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_GENERATOR,
  idempotencyInterceptor,
  SKIP_IDEMPOTENCY_HEADER,
  withIdempotency,
} from './idempotency-interceptor';

const setup = () => {
  let counter = 0;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([idempotencyInterceptor])),
      provideHttpClientTesting(),
      { provide: IDEMPOTENCY_KEY_GENERATOR, useValue: () => `key-${++counter}` },
    ],
  });
  return {
    httpMock: TestBed.inject(HttpTestingController),
    http: TestBed.inject(HttpClient),
  };
};

describe('idempotencyInterceptor', () => {
  it('attaches an Idempotency-Key on POST', () => {
    const { http, httpMock } = setup();
    http.post('/api/x', { a: 1 }).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get(IDEMPOTENCY_HEADER)).toBe('key-1');
    req.flush({});
    httpMock.verify();
  });

  it('attaches keys on PATCH and PUT', () => {
    const { http, httpMock } = setup();
    http.patch('/api/p', {}).subscribe();
    http.put('/api/u', {}).subscribe();
    const reqs = httpMock.match(() => true);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].request.headers.get(IDEMPOTENCY_HEADER)).toBe('key-1');
    expect(reqs[1].request.headers.get(IDEMPOTENCY_HEADER)).toBe('key-2');
    reqs.forEach(r => r.flush({}));
    httpMock.verify();
  });

  it('does NOT attach keys on idempotent verbs (GET/HEAD/DELETE/OPTIONS)', () => {
    const { http, httpMock } = setup();
    http.get('/api/get').subscribe();
    http.delete('/api/del').subscribe();
    const reqs = httpMock.match(() => true);
    reqs.forEach(r => {
      expect(r.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
      r.flush({});
    });
    httpMock.verify();
  });

  it('preserves an existing Idempotency-Key set by the caller', () => {
    const { http, httpMock } = setup();
    http.post('/api/x', {}, { headers: { [IDEMPOTENCY_HEADER]: 'caller-key' } }).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get(IDEMPOTENCY_HEADER)).toBe('caller-key');
    req.flush({});
    httpMock.verify();
  });

  it('honours X-Skip-Idempotency: strips the header and skips key attachment', () => {
    const { http, httpMock } = setup();
    http.post('/api/x', {}, { headers: { [SKIP_IDEMPOTENCY_HEADER]: 'true' } }).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.has(IDEMPOTENCY_HEADER)).toBe(false);
    expect(req.request.headers.has(SKIP_IDEMPOTENCY_HEADER)).toBe(false);
    req.flush({});
    httpMock.verify();
  });
});

describe('withIdempotency (fetch wrapper)', () => {
  it('attaches Idempotency-Key on POST', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withIdempotency(fakeFetch, () => 'k1');
    await wrapped('/api/x', { method: 'POST', body: '{}' });
    expect(captured?.get(IDEMPOTENCY_HEADER)).toBe('k1');
  });

  it('does not attach key on GET', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withIdempotency(fakeFetch, () => 'k1');
    await wrapped('/api/x', { method: 'GET' });
    expect(captured?.has(IDEMPOTENCY_HEADER)).toBe(false);
  });

  it('preserves an Idempotency-Key set by the caller', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withIdempotency(fakeFetch, () => 'gen');
    await wrapped('/api/x', {
      method: 'POST',
      headers: { [IDEMPOTENCY_HEADER]: 'caller' },
    });
    expect(captured?.get(IDEMPOTENCY_HEADER)).toBe('caller');
  });

  it('honours X-Skip-Idempotency: strips the header and skips attachment', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withIdempotency(fakeFetch, () => 'k1');
    await wrapped('/api/x', {
      method: 'POST',
      headers: { [SKIP_IDEMPOTENCY_HEADER]: 'true' },
    });
    expect(captured?.has(IDEMPOTENCY_HEADER)).toBe(false);
    expect(captured?.has(SKIP_IDEMPOTENCY_HEADER)).toBe(false);
  });

  it('reads the method from a Request input when init.method is omitted', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(
        init?.headers ?? (_input instanceof Request ? _input.headers : undefined)
      );
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withIdempotency(fakeFetch, () => 'k1');
    const req = new Request('https://example.test/api/x', { method: 'POST' });
    await wrapped(req);
    expect(captured?.get(IDEMPOTENCY_HEADER)).toBe('k1');
  });
});
