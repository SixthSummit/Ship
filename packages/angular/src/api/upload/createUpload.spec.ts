import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors/ApiError';
import { createUpload } from './createUpload';

/**
 * Lightweight XMLHttpRequest mock. Records all interactions on a captured
 * instance and exposes lifecycle triggers so specs drive behaviour.
 */
class MockXhr {
  static instances: MockXhr[] = [];
  upload = {
    onprogress: null as ((ev: ProgressEvent) => void) | null,
    onload: null as (() => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  statusText = '';
  responseText = '';
  private readonly headers: Record<string, string> = {};
  private readonly responseHeaders: Record<string, string> = {};
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;

  constructor() {
    MockXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getRequestHeader(k: string): string | undefined {
    return this.headers[k];
  }
  getResponseHeader(k: string): string | null {
    return this.responseHeaders[k.toLowerCase()] ?? null;
  }
  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }

  // Test-side helpers
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  finishLoad() {
    this.upload.onload?.();
  }
  respond(status: number, body = '', headers: Record<string, string> = {}) {
    this.status = status;
    this.statusText = status === 200 ? 'OK' : status === 422 ? 'Unprocessable' : 'ERR';
    this.responseText = body;
    Object.entries(headers).forEach(([k, v]) => {
      this.responseHeaders[k.toLowerCase()] = v;
    });
    this.onload?.();
  }
  errorOut() {
    this.onerror?.();
  }
}

const lastXhr = (): MockXhr => MockXhr.instances[MockXhr.instances.length - 1];

beforeEach(() => {
  MockXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', MockXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createUpload', () => {
  it('starts in idle with progress 0', () => {
    const u = createUpload('/api/upload');
    expect(u.status()).toBe('idle');
    expect(u.progress()).toBe(0);
    expect(u.value()).toBeUndefined();
  });

  it('opens an XHR with the correct method, URL, and FormData on start', () => {
    const u = createUpload('/api/upload', { method: 'POST' });
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    u.start(file);
    const x = lastXhr();
    expect(x.method).toBe('POST');
    expect(x.url).toBe('/api/upload');
    expect(x.body).toBeInstanceOf(FormData);
    const sent = (x.body as FormData).get('file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('a.txt');
  });

  it('honours custom field name and additional fields', () => {
    const u = createUpload('/api/x', { field: 'avatar', fields: { userId: 'u1' } });
    const f = new File(['a'], 'a.png', { type: 'image/png' });
    u.start(f);
    const fd = lastXhr().body as FormData;
    const avatar = fd.get('avatar');
    expect(avatar).toBeInstanceOf(File);
    expect((avatar as File).name).toBe('a.png');
    expect(fd.get('userId')).toBe('u1');
  });

  it('attaches custom headers and withCredentials', () => {
    const u = createUpload('/api/x', { headers: { 'X-Auth': 'tok' }, withCredentials: true });
    const f = new File(['a'], 'a.txt', { type: 'text/plain' });
    u.start(f);
    const x = lastXhr();
    expect(x.getRequestHeader('X-Auth')).toBe('tok');
    expect(x.withCredentials).toBe(true);
  });

  it('updates progress on transmission', () => {
    const u = createUpload<{ ok: boolean }>('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    expect(u.status()).toBe('uploading');
    lastXhr().emitProgress(50, 100);
    expect(u.progress()).toBe(0.5);
    lastXhr().emitProgress(100, 100);
    expect(u.progress()).toBe(1);
  });

  it('parses JSON response and transitions to complete on 2xx', () => {
    const u = createUpload<{ url: string }>('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(200, JSON.stringify({ url: '/cdn/a' }), {
      'content-type': 'application/json',
    });
    expect(u.status()).toBe('complete');
    expect(u.value()).toEqual({ url: '/cdn/a' });
  });

  it('returns text response when content-type is not JSON', () => {
    const u = createUpload<string>('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(200, 'OK', { 'content-type': 'text/plain' });
    expect(u.value()).toBe('OK');
  });

  it('honours custom parseResponse', () => {
    const u = createUpload<number>('/api/x', { parseResponse: xhr => xhr.responseText.length });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(200, 'hello world', { 'content-type': 'text/plain' });
    expect(u.value()).toBe(11);
  });

  it('on non-2xx, surfaces ApiError parsed from envelope JSON', () => {
    const u = createUpload('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(
      422,
      JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'too big' } }),
      { 'content-type': 'application/json' }
    );
    expect(u.status()).toBe('error');
    expect(u.error()).toBeInstanceOf(ApiError);
    expect((u.error() as ApiError).code).toBe('VALIDATION_ERROR');
  });

  it('synthesises ApiError on non-envelope error responses', () => {
    const u = createUpload('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(500, 'boom', { 'content-type': 'text/plain' });
    expect(u.error()).toBeInstanceOf(ApiError);
    expect((u.error() as ApiError).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('on transport error transitions to error with a generic Error', () => {
    const u = createUpload('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().errorOut();
    expect(u.status()).toBe('error');
    expect((u.error() as Error).message).toContain('network error');
  });

  it('rejects locally on file-too-large before opening XHR', () => {
    const u = createUpload('/api/x', { maxBytes: 5 });
    const big = new File(['hello world'], 'big.txt', { type: 'text/plain' });
    u.start(big);
    expect(u.status()).toBe('error');
    expect((u.error() as Error).message).toContain('maxBytes');
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('rejects locally on disallowed MIME before opening XHR', () => {
    const u = createUpload('/api/x', { accept: ['image/png'] });
    const f = new File(['a'], 'a.txt', { type: 'text/plain' });
    u.start(f);
    expect(u.status()).toBe('error');
    expect((u.error() as Error).message).toContain('not allowed');
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('abort() transitions to aborted', () => {
    const u = createUpload('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    expect(u.status()).toBe('uploading');
    u.abort();
    expect(u.status()).toBe('aborted');
  });

  it('reset() returns to idle', () => {
    const u = createUpload<string>('/api/x');
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    lastXhr().respond(200, 'OK', { 'content-type': 'text/plain' });
    expect(u.status()).toBe('complete');
    u.reset();
    expect(u.status()).toBe('idle');
    expect(u.value()).toBeUndefined();
    expect(u.progress()).toBe(0);
  });
});
