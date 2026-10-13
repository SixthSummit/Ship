import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Provider, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, RateLimitError } from '../errors/ApiError';
import { provideRateLimit, rateLimitInterceptor, withRateLimit } from './rate-limit-interceptor';

const setup = (extra: Provider[] = []) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([rateLimitInterceptor])),
      provideHttpClientTesting(),
      ...extra,
    ],
  });
  return {
    httpMock: TestBed.inject(HttpTestingController),
    http: TestBed.inject(HttpClient),
  };
};

const flushReq = (
  httpMock: HttpTestingController,
  url: string,
  init: { status: number; body?: unknown; headers?: Record<string, string> }
) => {
  const req = httpMock.expectOne(url);
  req.flush(init.body ?? null, {
    status: init.status,
    statusText: init.status === 429 ? 'Too Many Requests' : 'OK',
    headers: init.headers,
  });
  return req;
};

describe('rateLimitInterceptor — default (rethrow)', () => {
  it('passes 2xx responses through untouched', async () => {
    const { http, httpMock } = setup();
    const promise = firstValueFrom(http.get('/api/x'));
    flushReq(httpMock, '/api/x', { status: 200, body: { ok: true } });
    expect(await promise).toEqual({ ok: true });
    httpMock.verify();
  });

  it('rethrows 429 as RateLimitError with retryAfterSec from header', async () => {
    const { http, httpMock } = setup();
    const promise = firstValueFrom(http.get('/api/x'));
    flushReq(httpMock, '/api/x', {
      status: 429,
      headers: { 'Retry-After': '7' },
      body: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many' } },
    });
    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSec).toBe(7);
      expect((err as RateLimitError).code).toBe('RATE_LIMIT_EXCEEDED');
    }
    httpMock.verify();
  });

  it('non-429 errors pass through unchanged (not wrapped as RateLimitError)', async () => {
    const { http, httpMock } = setup();
    const promise = firstValueFrom(http.get('/api/x'));
    flushReq(httpMock, '/api/x', {
      status: 500,
      body: { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'oops' } },
    });
    await expect(promise).rejects.toBeInstanceOf(HttpErrorResponse);
    httpMock.verify();
  });

  it('synthesises a RateLimitError envelope when the body is not envelope-shaped', async () => {
    const { http, httpMock } = setup();
    const promise = firstValueFrom(http.get('/api/x'));
    flushReq(httpMock, '/api/x', {
      status: 429,
      headers: { 'Retry-After': '3' },
      body: 'rate limited',
    });
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).code).toBe('RATE_LIMIT_EXCEEDED');
      expect((err as RateLimitError).retryAfterSec).toBe(3);
    }
    httpMock.verify();
  });
});

describe('rateLimitInterceptor — autoRetry', () => {
  it('retries up to maxRetries on 429 then succeeds', async () => {
    const { http, httpMock } = setup([
      provideRateLimit({ autoRetry: true, maxRetries: 2, defaultBackoffMs: 1 }),
    ]);
    const promise = firstValueFrom(http.get('/api/x'));
    // First attempt
    flushReq(httpMock, '/api/x', { status: 429, headers: { 'Retry-After': '0' } });
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 5));
    // Second attempt
    flushReq(httpMock, '/api/x', { status: 429, headers: { 'Retry-After': '0' } });
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 5));
    // Third attempt — succeeds
    flushReq(httpMock, '/api/x', { status: 200, body: { ok: true } });
    expect(await promise).toEqual({ ok: true });
    httpMock.verify();
  });

  it('throws RateLimitError after exhausting retries', async () => {
    const { http, httpMock } = setup([
      provideRateLimit({ autoRetry: true, maxRetries: 1, defaultBackoffMs: 1 }),
    ]);
    const promise = firstValueFrom(http.get('/api/x'));
    flushReq(httpMock, '/api/x', { status: 429, headers: { 'Retry-After': '0' } });
    await new Promise(r => setTimeout(r, 5));
    flushReq(httpMock, '/api/x', {
      status: 429,
      headers: { 'Retry-After': '5' },
      body: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'nope' } },
    });
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSec).toBe(5);
    }
    httpMock.verify();
  });
});

describe('withRateLimit (fetch wrapper)', () => {
  it('passes 2xx through untouched', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const wrapped = withRateLimit(fakeFetch as unknown as typeof fetch);
    const res = await wrapped('/api/x');
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the 429 response unchanged when autoRetry is off (caller handles)', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(new Response('rate', { status: 429, headers: { 'Retry-After': '5' } }));
    const wrapped = withRateLimit(fakeFetch as unknown as typeof fetch);
    const res = await wrapped('/api/x');
    expect(res.status).toBe(429);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('caller can wrap the 429 response into a RateLimitError', async () => {
    const body = { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'too many' } };
    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 429,
        headers: { 'Retry-After': '4', 'content-type': 'application/json' },
      })
    );
    const wrapped = withRateLimit(fakeFetch as unknown as typeof fetch);
    const res = await wrapped('/api/x');
    const err = await ApiError.fromResponse(res);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSec).toBe(4);
  });

  it('autoRetry retries up to maxRetries with Retry-After delay', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('rate', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const wrapped = withRateLimit(fakeFetch as unknown as typeof fetch, {
      autoRetry: true,
      maxRetries: 2,
      defaultBackoffMs: 1,
    });
    const res = await wrapped('/api/x');
    expect(res.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('autoRetry returns last 429 response after exhausting retries', async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('still rate', { status: 429, headers: { 'Retry-After': '0' } })
      );
    const wrapped = withRateLimit(fakeFetch as unknown as typeof fetch, {
      autoRetry: true,
      maxRetries: 1,
      defaultBackoffMs: 1,
    });
    const res = await wrapped('/api/x');
    expect(res.status).toBe(429);
    expect(fakeFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});
