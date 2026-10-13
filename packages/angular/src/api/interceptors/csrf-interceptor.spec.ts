import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { csrfTokenInterceptor, provideCsrf, withCsrf } from './csrf-interceptor';

const setup = (extra: Provider[] = []) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([csrfTokenInterceptor])),
      provideHttpClientTesting(),
      ...extra,
    ],
  });
  return {
    httpMock: TestBed.inject(HttpTestingController),
    http: TestBed.inject(HttpClient),
  };
};

const setCookie = (kv: string) => {
  document.cookie = kv;
};

const clearAllCookies = () => {
  // jsdom: setting expires to past clears the cookie
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
};

describe('csrfTokenInterceptor', () => {
  beforeEach(() => clearAllCookies());
  afterEach(() => clearAllCookies());

  it('echoes the ship_csrf cookie as X-CSRF-Token on POST', () => {
    setCookie('ship_csrf=cookie-value');
    const { http, httpMock } = setup();
    http.post('/api/x', {}).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('X-CSRF-Token')).toBe('cookie-value');
    req.flush({});
    httpMock.verify();
  });

  it('echoes on PATCH / PUT / DELETE', () => {
    setCookie('ship_csrf=v');
    const { http, httpMock } = setup();
    http.patch('/api/p', {}).subscribe();
    http.put('/api/u', {}).subscribe();
    http.delete('/api/d').subscribe();
    const reqs = httpMock.match(() => true);
    expect(reqs).toHaveLength(3);
    reqs.forEach(r => {
      expect(r.request.headers.get('X-CSRF-Token')).toBe('v');
      r.flush({});
    });
    httpMock.verify();
  });

  it('does NOT echo on GET / HEAD / OPTIONS', () => {
    setCookie('ship_csrf=v');
    const { http, httpMock } = setup();
    http.get('/api/g').subscribe();
    const req = httpMock.expectOne('/api/g');
    expect(req.request.headers.has('X-CSRF-Token')).toBe(false);
    req.flush({});
    httpMock.verify();
  });

  it('skips when the cookie is missing', () => {
    const { http, httpMock } = setup();
    http.post('/api/x', {}).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.has('X-CSRF-Token')).toBe(false);
    req.flush({});
    httpMock.verify();
  });

  it('preserves a caller-set X-CSRF-Token', () => {
    setCookie('ship_csrf=cookie');
    const { http, httpMock } = setup();
    http.post('/api/x', {}, { headers: { 'X-CSRF-Token': 'caller' } }).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('X-CSRF-Token')).toBe('caller');
    req.flush({});
    httpMock.verify();
  });

  it('honours provideCsrf({ cookieName, headerName }) overrides', () => {
    setCookie('XSRF-TOKEN=xv');
    const { http, httpMock } = setup([
      provideCsrf({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
    ]);
    http.post('/api/x', {}).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('X-XSRF-TOKEN')).toBe('xv');
    req.flush({});
    httpMock.verify();
  });

  it('decodes URL-encoded cookie values', () => {
    setCookie('ship_csrf=' + encodeURIComponent('with space + symbol'));
    const { http, httpMock } = setup();
    http.post('/api/x', {}).subscribe();
    const req = httpMock.expectOne('/api/x');
    expect(req.request.headers.get('X-CSRF-Token')).toBe('with space + symbol');
    req.flush({});
    httpMock.verify();
  });
});

describe('withCsrf (fetch wrapper)', () => {
  beforeEach(() => clearAllCookies());
  afterEach(() => clearAllCookies());

  it('echoes ship_csrf cookie as X-CSRF-Token on POST', async () => {
    setCookie('ship_csrf=v');
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withCsrf(fakeFetch);
    await wrapped('/api/x', { method: 'POST' });
    expect(captured?.get('X-CSRF-Token')).toBe('v');
  });

  it('does not echo on GET', async () => {
    setCookie('ship_csrf=v');
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withCsrf(fakeFetch);
    await wrapped('/api/x', { method: 'GET' });
    expect(captured?.has('X-CSRF-Token')).toBe(false);
  });

  it('preserves a caller-set X-CSRF-Token', async () => {
    setCookie('ship_csrf=v');
    let captured: Headers | undefined;
    const fakeFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrapped = withCsrf(fakeFetch);
    await wrapped('/api/x', { method: 'POST', headers: { 'X-CSRF-Token': 'caller' } });
    expect(captured?.get('X-CSRF-Token')).toBe('caller');
  });
});
