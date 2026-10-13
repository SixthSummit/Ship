import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider, provideZonelessChangeDetection, REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_ID_GENERATOR,
  REQUEST_ID_HEADER,
  requestIdInterceptor,
  withRequestId,
} from './request-id-interceptor';

const setup = (extra: Provider[] = []) => {
  let counter = 0;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([requestIdInterceptor])),
      provideHttpClientTesting(),
      { provide: REQUEST_ID_GENERATOR, useValue: () => `id-${++counter}` },
      ...extra,
    ],
  });
  return {
    httpMock: TestBed.inject(HttpTestingController),
    http: TestBed.inject(HttpClient),
  };
};

describe('requestIdInterceptor', () => {
  it('attaches a generated request-id when none is set', () => {
    const { http, httpMock } = setup();
    http.get('/api/x').subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get(REQUEST_ID_HEADER)).toBe('id-1');
    req.flush({});
    httpMock.verify();
  });

  it('preserves a caller-set request-id', () => {
    const { http, httpMock } = setup();
    http.get('/api/x', { headers: { [REQUEST_ID_HEADER]: 'caller' } }).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get(REQUEST_ID_HEADER)).toBe('caller');
    req.flush({});
    httpMock.verify();
  });

  it('forwards the SSR Request X-Request-ID across outbound calls', () => {
    const ssrReq = new Request('https://example.test/x', {
      headers: { [REQUEST_ID_HEADER]: 'lb-supplied' },
    });
    const { http, httpMock } = setup([{ provide: REQUEST, useValue: ssrReq }]);
    http.get('/api/x').subscribe();
    http.get('/api/y').subscribe();
    const reqs = httpMock.match(() => true);
    reqs.forEach(r => {
      expect(r.request.headers.get(REQUEST_ID_HEADER)).toBe('lb-supplied');
      r.flush({});
    });
    httpMock.verify();
  });

  it('falls back to the generator when SSR Request has no request-id header', () => {
    const ssrReq = new Request('https://example.test/x');
    const { http, httpMock } = setup([{ provide: REQUEST, useValue: ssrReq }]);
    http.get('/api/x').subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get(REQUEST_ID_HEADER)).toBe('id-1');
    req.flush({});
    httpMock.verify();
  });
});

describe('withRequestId (fetch wrapper)', () => {
  it('attaches a generated request-id', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withRequestId(fakeFetch, () => 'id-1');
    await wrapped('/api/x');
    expect(captured?.get(REQUEST_ID_HEADER)).toBe('id-1');
  });

  it('preserves an existing X-Request-ID', async () => {
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withRequestId(fakeFetch, () => 'gen');
    await wrapped('/api/x', { headers: { [REQUEST_ID_HEADER]: 'caller' } });
    expect(captured?.get(REQUEST_ID_HEADER)).toBe('caller');
  });
});
