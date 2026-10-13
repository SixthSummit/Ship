import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignedUpload } from './createSignedUpload';

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
  method = '';
  url = '';
  body: Document | XMLHttpRequestBodyInit | null = null;
  private readonly headers: Record<string, string> = {};

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
  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
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

const flush = () => new Promise(r => setTimeout(r, 0));

describe('createSignedUpload', () => {
  it('signs then PUTs the raw file to the signed URL', async () => {
    const u = createSignedUpload({
      signRequest: async file => ({
        url: `https://storage.example/${file.name}`,
        headers: { 'Content-Type': file.type },
      }),
    });
    const f = new File(['payload'], 'a.txt', { type: 'text/plain' });
    u.start(f);
    expect(u.status()).toBe('uploading');
    await flush();
    const x = lastXhr();
    expect(x.method).toBe('PUT');
    expect(x.url).toBe('https://storage.example/a.txt');
    expect(x.body).toBe(f);
    expect(x.getRequestHeader('Content-Type')).toBe('text/plain');
    x.respond(200);
    expect(u.status()).toBe('complete');
    expect(u.destinationUrl()).toBe('https://storage.example/a.txt');
  });

  it('reports progress during the storage PUT', async () => {
    const u = createSignedUpload({
      signRequest: async () => ({ url: 'https://storage.example/x' }),
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    const x = lastXhr();
    x.emitProgress(50, 100);
    expect(u.progress()).toBe(0.5);
    x.emitProgress(100, 100);
    expect(u.progress()).toBe(1);
  });

  it('surfaces a sign-request rejection on error()', async () => {
    const fail = new Error('sign failed');
    const u = createSignedUpload({
      signRequest: async () => {
        throw fail;
      },
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    expect(u.status()).toBe('error');
    expect(u.error()).toBe(fail);
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('surfaces a non-2xx PUT response as an error', async () => {
    const u = createSignedUpload({
      signRequest: async () => ({ url: 'https://storage.example/x' }),
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    lastXhr().respond(403);
    expect(u.status()).toBe('error');
    expect((u.error() as Error).message).toContain('storage rejected');
  });

  it('abort() during signing prevents the PUT from being issued', async () => {
    let resolveSign: ((r: { url: string }) => void) | undefined;
    const u = createSignedUpload({
      signRequest: () => new Promise<{ url: string }>(r => (resolveSign = r)),
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    u.abort();
    expect(u.status()).toBe('aborted');
    resolveSign!({ url: 'https://storage.example/x' });
    await flush();
    expect(MockXhr.instances).toHaveLength(0);
  });

  it('abort() during PUT transitions to aborted', async () => {
    const u = createSignedUpload({
      signRequest: async () => ({ url: 'https://storage.example/x' }),
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    expect(u.status()).toBe('uploading');
    u.abort();
    expect(u.status()).toBe('aborted');
  });

  it('reset() returns to idle and clears destinationUrl', async () => {
    const u = createSignedUpload({
      signRequest: async () => ({ url: 'https://storage.example/x' }),
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    lastXhr().respond(200);
    expect(u.status()).toBe('complete');
    u.reset();
    expect(u.status()).toBe('idle');
    expect(u.destinationUrl()).toBeUndefined();
  });

  it('honours method override (POST) for storage backends that require it', async () => {
    const u = createSignedUpload({
      signRequest: async () => ({ url: 'https://storage.example/x' }),
      method: 'POST',
    });
    u.start(new File(['a'], 'a.txt', { type: 'text/plain' }));
    await flush();
    expect(lastXhr().method).toBe('POST');
  });
});
