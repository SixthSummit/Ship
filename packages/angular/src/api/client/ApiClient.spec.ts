import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpRequestError } from '../errors/HttpRequestError';
import ApiClient from './ApiClient';

describe('ApiClient', () => {
  let api: ApiClient;
  let httpController: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    api = TestBed.inject(ApiClient);
    httpController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpController.verify();
  });

  it('GET issues a GET request', async () => {
    const promise = api.get<{ id: string }>('/api/users/1');
    const req = httpController.expectOne('/api/users/1');
    expect(req.request.method).toBe('GET');
    req.flush({ id: '1' });
    expect(await promise).toEqual({ id: '1' });
  });

  it('POST sends body', async () => {
    const promise = api.post('/api/users', { name: 'Alice' });
    const req = httpController.expectOne('/api/users');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Alice' });
    req.flush({ id: '1' });
    await promise;
  });

  it('PATCH sends body', async () => {
    const promise = api.patch('/api/users/1', { name: 'Bob' });
    const req = httpController.expectOne('/api/users/1');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'Bob' });
    req.flush({});
    await promise;
  });

  it('PUT sends body', async () => {
    const promise = api.put('/api/users/1', { name: 'Carol' });
    const req = httpController.expectOne('/api/users/1');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'Carol' });
    req.flush({});
    await promise;
  });

  it('DELETE issues a DELETE request', async () => {
    const promise = api.delete('/api/users/1');
    const req = httpController.expectOne('/api/users/1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    await promise;
  });

  it('preserves a third-party error body, status, headers, and message', async () => {
    const promise = api.get('/api/fail');
    const req = httpController.expectOne('/api/fail');
    req.flush(
      { message: 'something broke', code: 'UPSTREAM_FAILURE', details: { retryable: false } },
      {
        status: 500,
        statusText: 'Server Error',
        headers: { 'X-Request-Id': 'request-1' },
      }
    );

    await expect(promise).rejects.toMatchObject({
      name: 'HttpRequestError',
      message: 'something broke',
      status: 500,
      statusText: 'Server Error',
      requestId: 'request-1',
      code: 'UPSTREAM_FAILURE',
      details: { retryable: false },
      responseBody: {
        message: 'something broke',
        code: 'UPSTREAM_FAILURE',
        details: { retryable: false },
      },
      headers: { 'x-request-id': 'request-1' },
    });
    await promise.catch(error => expect(error).toBeInstanceOf(HttpRequestError));
  });

  it('preserves a ShipAPI-compatible nested error without requiring ShipAPI types', async () => {
    const promise = api.get('/api/me');
    const req = httpController.expectOne('/api/me');
    req.flush(
      {
        success: false,
        requestId: 'body-request',
        error: {
          code: 'NO_USER_RECORD',
          message: 'No user profile exists',
          details: { onboarding: true },
        },
      },
      { status: 404, statusText: 'Not Found' }
    );

    await expect(promise).rejects.toMatchObject({
      message: 'No user profile exists',
      status: 404,
      requestId: 'body-request',
      code: 'NO_USER_RECORD',
      details: { onboarding: true },
    });
  });

  it('preserves a non-JSON proxy body instead of fabricating an application error', async () => {
    const promise = api.get('/api/proxy-failure');
    const req = httpController.expectOne('/api/proxy-failure');
    req.flush('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' });

    await expect(promise).rejects.toMatchObject({
      name: 'HttpRequestError',
      status: 502,
      responseBody: '<html>Bad Gateway</html>',
      code: undefined,
    });
  });

  it('threads ApiOptions through to the underlying request', async () => {
    const promise = api.get('/api/users', {
      params: { search: 'alice' },
      headers: { 'X-Trace-Id': 'abc' },
    });
    const req = httpController.expectOne(r => r.url === '/api/users');
    expect(req.request.headers.get('X-Trace-Id')).toBe('abc');
    expect(req.request.params.get('search')).toBe('alice');
    req.flush([]);
    await promise;
  });

  it('threads blob response mode and progress options to HttpClient', async () => {
    const promise = api.get<Blob>('/api/report', {
      responseType: 'blob',
      reportProgress: true,
    });
    const req = httpController.expectOne('/api/report');
    const blob = new Blob(['report'], { type: 'application/pdf' });

    expect(req.request.responseType).toBe('blob');
    expect(req.request.reportProgress).toBe(true);
    req.flush(blob);
    await expect(promise).resolves.toBe(blob);
  });

  it('returns text without attempting JSON decoding', async () => {
    const promise = api.get<string>('/api/readme', { responseType: 'text' });
    const req = httpController.expectOne('/api/readme');

    expect(req.request.responseType).toBe('text');
    req.flush('plain text');
    await expect(promise).resolves.toBe('plain text');
  });

  it('returns exact array-buffer bytes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]).buffer;
    const promise = api.get<ArrayBuffer>('/api/bytes', { responseType: 'arraybuffer' });
    const req = httpController.expectOne('/api/bytes');

    expect(req.request.responseType).toBe('arraybuffer');
    req.flush(bytes);
    await expect(promise).resolves.toBe(bytes);
  });

  it('rethrows non-HTTP programmer errors unchanged', async () => {
    const programmerError = new Error('subscription failed');
    const broken = {
      request: () => {
        throw programmerError;
      },
    };
    Object.defineProperty(api, 'httpClient', { value: broken });

    await expect(api.get('/api/users')).rejects.toBe(programmerError);
  });
});
