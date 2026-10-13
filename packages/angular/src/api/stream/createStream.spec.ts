import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors/ApiError';
import { createStream } from './createStream';

const sseStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
};

const sseResponse = (chunks: string[]): Response =>
  new Response(sseStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const flush = (n = 5) =>
  Array.from({ length: n }, () => new Promise<void>(r => setTimeout(r, 0))).reduce(
    (p, q) => p.then(() => q),
    Promise.resolve()
  );

describe('createStream — URL overload', () => {
  it('decodes JSON-data SSE frames into events', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(['data: {"x":1}\n\n', 'data: {"x":2}\n\n']));
    const s = createStream<{ x: number }>('/api/x', {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await flush();
    expect(s.events()).toEqual([{ x: 1 }, { x: 2 }]);
    expect(s.status()).toBe('closed');
  });

  it('uses a custom decoder', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: token\ndata: hello\n\n', 'event: token\ndata: world\n\n'])
      );
    const s = createStream<string>('/api/x', {
      fetch: fetchImpl as unknown as typeof fetch,
      decode: f => (f.event === 'token' ? f.data : undefined),
    });
    await flush();
    expect(s.events()).toEqual(['hello', 'world']);
  });

  it('skips frames the decoder returns undefined for', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sseResponse(['data: 1\n\n', 'data: [DONE]\n\n', 'data: 2\n\n']));
    const s = createStream<number>('/api/x', { fetch: fetchImpl as unknown as typeof fetch });
    await flush();
    expect(s.events()).toEqual([1, 2]);
  });

  it('sets status to error and surfaces ApiError on non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    );
    const s = createStream('/api/x', { fetch: fetchImpl as unknown as typeof fetch });
    await flush();
    expect(s.status()).toBe('error');
    expect(s.error()).toBeInstanceOf(ApiError);
    expect((s.error() as ApiError).code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('sends method, body (JSON-stringified), and headers', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), init };
      return Promise.resolve(sseResponse(['data: ok\n\n']));
    }) as unknown as typeof fetch;
    createStream<string>('/api/x', {
      fetch: fetchImpl,
      method: 'POST',
      body: { a: 1 },
      headers: { 'X-Custom': 'v' },
      decode: f => f.data,
    });
    await flush();
    expect(captured?.url).toBe('/api/x');
    expect(captured?.init?.method).toBe('POST');
    expect(captured?.init?.body).toBe(JSON.stringify({ a: 1 }));
    const headers = new Headers(captured?.init?.headers);
    expect(headers.get('X-Custom')).toBe('v');
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('passes raw body unchanged for FormData / Blob', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(sseResponse([]));
    }) as unknown as typeof fetch;
    const fd = new FormData();
    fd.append('k', 'v');
    createStream('/api/x', { fetch: fetchImpl, method: 'POST', body: fd as unknown as never });
    await flush();
    expect(captured?.body).toBe(fd);
  });

  it('abort() transitions status to aborted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
            // Keep open
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    );
    const s = createStream<number>('/api/x', { fetch: fetchImpl as unknown as typeof fetch });
    await flush();
    s.abort();
    await flush();
    expect(s.status()).toBe('aborted');
  });

  it('reload() restarts the stream and clears events', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(['data: 1\n\n']))
      .mockResolvedValueOnce(sseResponse(['data: 2\n\n']));
    const s = createStream<number>('/api/x', { fetch: fetchImpl as unknown as typeof fetch });
    await flush();
    expect(s.events()).toEqual([1]);
    expect(s.status()).toBe('closed');
    s.reload();
    await flush();
    expect(s.events()).toEqual([2]);
    expect(s.status()).toBe('closed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sets status closed on empty body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const s = createStream('/api/x', { fetch: fetchImpl as unknown as typeof fetch });
    await flush();
    expect(s.status()).toBe('closed');
    expect(s.events()).toEqual([]);
  });
});

describe('createStream — thunk overload', () => {
  it('opens a stream from a thunk that returns a Response', async () => {
    const thunk = () => Promise.resolve(sseResponse(['data: a\n\n', 'data: b\n\n']));
    const s = createStream<string>(thunk, { decode: f => f.data });
    await flush();
    expect(s.events()).toEqual(['a', 'b']);
    expect(s.status()).toBe('closed');
  });

  it('surfaces non-OK responses as ApiError on error()', async () => {
    const thunk = () => Promise.resolve(new Response('nope', { status: 500 }));
    const s = createStream(thunk);
    await flush();
    expect(s.status()).toBe('error');
    expect(s.error()).toBeInstanceOf(ApiError);
  });
});
