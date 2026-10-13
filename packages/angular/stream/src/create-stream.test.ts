import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStream, type ShipStreamStatus } from './create-stream';
import type { ShipStreamManifest } from './ship-stream-manifest';

interface StreamContract {
  readonly operations: {
    readonly 'agent.run': {
      readonly transport: 'stream';
      readonly input: {
        readonly params: { readonly agentId: string };
        readonly query?: { readonly since?: string };
        readonly body?: { readonly prompt: string };
      };
      readonly result:
        | {
            readonly ok: true;
            readonly status: 200;
            readonly data: {
              readonly frame: { readonly delta: string };
              readonly terminal: { readonly tokens: number };
            };
          }
        | {
            readonly ok: false;
            readonly status: 401;
            readonly error: { readonly code: 'AUTHENTICATION_ERROR'; readonly message: string };
          };
    };
  };
}

const FINGERPRINT = `sha256:${'a'.repeat(64)}` as const;

const manifest: ShipStreamManifest = {
  schemaVersion: 1,
  appId: 'ship-angular-stream-tests',
  fingerprint: FINGERPRINT,
  operations: [
    {
      id: 'accounts.get',
      method: 'GET',
      path: '/accounts/:accountId',
      success: [{ status: 200 }],
      errors: [],
    },
    {
      id: 'agent.run',
      method: 'POST',
      path: '/agents/:agentId/run',
      success: [{ status: 200 }],
      errors: [{ code: 'AUTHENTICATION_ERROR', status: 401 }],
      response: {
        mode: 'stream',
        framing: 'sse',
        frame: { $ref: '#/schemas/Delta' },
        terminal: { $ref: '#/schemas/Usage' },
        limits: { heartbeatMs: 15_000, maxDurationMs: 60_000, maxFrames: 2 },
      },
    },
  ],
};

function reference(input?: StreamContract['operations']['agent.run']['input']) {
  return {
    manifest,
    operation: 'agent.run',
    input: input ?? { params: { agentId: 'agent-1' }, body: { prompt: 'hello' } },
    baseUrl: 'https://api.example.test/v1',
  } as const;
}

function sse(chunks: readonly string[], status = 200, headers: HeadersInit = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers } }
  );
}

/** An SSE response whose body stays open after the supplied chunks. */
function openSse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          await new Promise(() => undefined);
          return;
        }
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
  );
}

function envelope(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code, message: `${code} message`, details: { safe: true } },
    }),
    { status, headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' } }
  );
}

async function settle(status: () => ShipStreamStatus): Promise<ShipStreamStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = status();
    if (value === 'closed' || value === 'error' || value === 'aborted') return value;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Stream never settled (status=${status()})`);
}

async function waitForStatus(
  status: () => ShipStreamStatus,
  expected: ShipStreamStatus
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (status() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Stream never reached ${expected} (status=${status()})`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStream', () => {
  it('builds the manifest request, ignores heartbeats, and walks connecting to closed', async () => {
    const transitions: ShipStreamStatus[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('text/event-stream');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-tenant')).toBe('acme');
      expect(init?.body).toBe(JSON.stringify({ prompt: 'hello' }));
      return sse([
        ': hb 1700000000000\n\n',
        'id: 1\nevent: frame\ndata: {"delta":"he',
        'llo"}\n\n: hb 1700000000015\n\n',
        'id: 2\nevent: frame\ndata: {"delta":" world"}\n\n',
        'id: 3\nevent: terminal\ndata: {"tokens":7}\n\n',
      ]);
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
      headers: { 'X-Tenant': 'acme' },
      onFrame: (_frame, seq) => transitions.push(`seq-${seq}` as ShipStreamStatus),
    });

    expect(stream.status()).toBe('connecting');
    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/agents/agent-1/run',
      expect.any(Object)
    );
    expect(stream.frames()).toEqual([{ delta: 'hello' }, { delta: ' world' }]);
    expect(stream.latest()).toEqual({ delta: ' world' });
    expect(stream.terminal()).toEqual({ tokens: 7 });
    expect(stream.seq()).toBe(3);
    expect(stream.error()).toBeUndefined();
    expect(transitions).toEqual(['seq-1', 'seq-2']);
  });

  it('applies params and query to a GET stream and bounds retained frames', async () => {
    const getManifest: ShipStreamManifest = {
      ...manifest,
      operations: manifest.operations.map(operation =>
        operation.id === 'agent.run' ? { ...operation, method: 'GET' } : operation
      ),
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        'id: 2\nevent: frame\ndata: {"delta":"b"}\n\n',
        'id: 3\nevent: frame\ndata: {"delta":"c"}\n\n',
        'id: 4\nevent: terminal\ndata: null\n\n',
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(
      {
        manifest: getManifest,
        operation: 'agent.run',
        input: { params: { agentId: 'a b' }, query: { since: 'cursor-1' } },
        baseUrl: 'https://api.example.test/v1',
      },
      { fetch: fetchMock, platform: 'browser' }
    );

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/agents/a%20b/run?since=cursor-1',
      expect.any(Object)
    );
    // The manifest declares maxFrames: 2, so the oldest frame is dropped.
    expect(stream.frames()).toEqual([{ delta: 'b' }, { delta: 'c' }]);
    expect(stream.terminal()).toBeUndefined();
  });

  it('surfaces a pre-first-frame JSON error envelope as the client error type', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => envelope(401, 'AUTHENTICATION_ERROR'));

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'AUTHENTICATION_ERROR',
      status: 401,
      message: 'AUTHENTICATION_ERROR message',
      details: { safe: true },
    });
    expect(stream.frames()).toEqual([]);
  });

  it('keeps frames received before a terminal error event', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'id: 1\nevent: frame\ndata: {"delta":"partial"}\n\n',
        'id: 2\nevent: error\ndata: {"code":"STREAM_MAX_DURATION_EXCEEDED","status":504,"message":"too long"}\n\n',
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.frames()).toEqual([{ delta: 'partial' }]);
    expect(stream.error()).toEqual({
      code: 'STREAM_MAX_DURATION_EXCEEDED',
      status: 504,
      message: 'too long',
    });
    expect(stream.seq()).toBe(2);
  });

  it('reports STREAM_INTERRUPTED when the body ends without a terminal or error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(['id: 1\nevent: frame\ndata: {"delta":"only"}\n\n'])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_INTERRUPTED');
  });

  it('reports STREAM_TRANSPORT_FAILED when the request never reaches the server', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'STREAM_TRANSPORT_FAILED',
      status: 0,
      message: 'Failed to fetch',
    });
  });

  it('reports a protocol violation for a non-SSE success response', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } })
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
  });

  it('reports a protocol violation for an SSE response with a non-200 status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse(['data: ignored\n\n'], 202));

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'STREAM_PROTOCOL_VIOLATION',
      status: 0,
      message: 'A stream response must use status 200, received 202',
    });
  });

  it('reports a protocol violation for an undecodable frame', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(['id: 1\nevent: frame\ndata: not-json\n\n'])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
  });

  it('reports a protocol violation when the manifest does not declare a stream', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse([]));

    const stream = createStream({
      manifest,
      operation: 'accounts.get',
      input: { params: { accountId: 'account-1' } },
      baseUrl: 'https://api.example.test/v1',
    });

    expect(stream.status()).toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts on request, stops reporting, and asks the transport to cancel', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return openSse(['id: 1\nevent: frame\ndata: {"delta":"first"}\n\n']);
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    stream.abort();

    await expect(settle(stream.status)).resolves.toBe('aborted');
    expect(observedSignal?.aborted).toBe(true);
    expect(stream.error()).toBeUndefined();
    stream.abort();
    expect(stream.status()).toBe('aborted');
  });

  it('aborts from an external signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
      signal: controller.signal,
    });

    await expect(settle(stream.status)).resolves.toBe('aborted');
  });

  it('never opens a request under server rendering', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse([]));

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'server',
    });

    expect(stream.status()).toBe('idle');
    expect(stream.frames()).toEqual([]);
    expect(stream.terminal()).toBeUndefined();
    expect(stream.error()).toBeUndefined();
    expect(stream.seq()).toBe(0);
    stream.abort();
    expect(stream.status()).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens nothing when PLATFORM_ID reports a server render', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse([]));
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: 'server' }],
    });

    const stream = TestBed.runInInjectionContext(() =>
      createStream<StreamContract, 'agent.run'>(reference(), { fetch: fetchMock })
    );

    expect(stream.status()).toBe('idle');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens a request when PLATFORM_ID reports a browser render', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(['id: 1\nevent: terminal\ndata: {"tokens":0}\n\n'])
    );
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: 'browser' }],
    });

    const stream = TestBed.runInInjectionContext(() =>
      createStream<StreamContract, 'agent.run'>(reference(), { fetch: fetchMock })
    );

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a protocol violation for a malformed error event payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(['id: 1\nevent: error\ndata: {"code":"X"}\n\n'])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
  });

  it('prefers abort over a decoding failure raised while aborting', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      openSse(['id: 1\nevent: frame\ndata: {"delta":"first"}\n\n'])
    );
    const raced: { abort?: () => void } = {};

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
      decodeFrame: () => {
        raced.abort?.();
        throw new TypeError('decode raced the abort');
      },
    });
    raced.abort = () => stream.abort();

    await expect(settle(stream.status)).resolves.toBe('aborted');
    expect(stream.error()).toBeUndefined();
  });

  it('does not start when the external signal is already aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse([]));

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
      signal: AbortSignal.abort(),
    });

    await expect(settle(stream.status)).resolves.toBe('aborted');
  });

  it('describes a non-Error transport rejection without inventing a message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw 'offline';
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'STREAM_TRANSPORT_FAILED',
      status: 0,
      message: 'The stream failed for an unknown reason',
    });
  });

  it('reports STREAM_INTERRUPTED when the success response carries no body', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_INTERRUPTED');
  });

  it('reports a protocol violation for a response with no Content-Type', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = new Response('', { status: 200 });
      response.headers.delete('content-type');
      return response;
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
  });

  it('reports a protocol violation when the error envelope is not the wire shape', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: 'nope' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.code).toBe('STREAM_PROTOCOL_VIOLATION');
  });

  it('honours custom decoders, an explicit request, and a maxFrames override', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(new Headers(init?.headers).get('x-trace')).toBe('trace-1');
      expect(init?.body).toBe('{"prompt":"hi"}');
      return sse([
        'id: 1\nevent: frame\ndata: alpha\n\n',
        'id: 2\nevent: frame\ndata: beta\n\n',
        'id: 3\nevent: terminal\ndata: done\n\n',
      ]);
    });

    const stream = createStream<string, string>(
      {
        url: 'https://api.example.test/events',
        method: 'POST',
        headers: { 'x-trace': 'trace-1' },
        body: '{"prompt":"hi"}',
      },
      {
        fetch: fetchMock,
        platform: 'browser',
        credentials: 'include',
        maxFrames: 1,
        decodeFrame: data => data.toUpperCase(),
        decodeTerminal: data => `${data}!`,
      }
    );

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual(['BETA']);
    expect(stream.terminal()).toBe('done!');
  });

  it('accepts an explicit request without a manifest', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      return sse(['id: 1\nevent: frame\ndata: {"n":1}\n\nid: 2\nevent: terminal\ndata: null\n\n']);
    });

    const stream = createStream<{ readonly n: number }>('https://api.example.test/events', {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual([{ n: 1 }]);
  });
});

describe('createStream pinned wire details', () => {
  it('reads the canonical id/event/data field order with single-line JSON data', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        `id: 1\nevent: frame\ndata: ${JSON.stringify({ delta: 'a"b\nc' })}\n\n`,
        `id: 2\nevent: terminal\ndata: ${JSON.stringify({ tokens: 1 })}\n\n`,
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual([{ delta: 'a"b\nc' }]);
    expect(stream.terminal()).toEqual({ tokens: 1 });
  });

  it('increments seq across frame, terminal, and error events without heartbeats consuming one', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        ': hb 1700000000000\n\n',
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        ': hb 1700000000010\n\n',
        'id: 2\nevent: frame\ndata: {"delta":"b"}\n\n',
        ': hb 1700000000020\n\n',
        'id: 3\nevent: terminal\ndata: {"tokens":2}\n\n',
      ])
    );
    const observed: number[] = [];

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
      onFrame: (_frame, seq) => observed.push(seq),
    });

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(observed).toEqual([1, 2]);
    expect(stream.seq()).toBe(3);
  });

  it('ignores a heartbeat that is the only thing on the wire before the stream ends', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sse([': hb 1700000000000\n\n']));

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.frames()).toEqual([]);
    expect(stream.seq()).toBe(0);
    expect(stream.error()?.code).toBe('STREAM_INTERRUPTED');
  });

  it('surfaces the generic INTERNAL_ERROR frame verbatim and omits absent details', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'id: 1\nevent: error\ndata: {"code":"INTERNAL_ERROR","status":500,"message":"An unexpected error occurred"}\n\n',
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'INTERNAL_ERROR',
      status: 500,
      message: 'An unexpected error occurred',
    });
    expect(Object.hasOwn(stream.error() ?? {}, 'details')).toBe(false);
  });

  it('preserves details when a wire error event carries them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'id: 1\nevent: error\ndata: {"code":"AGENT_BUSY","status":409,"message":"busy","details":{"retryIn":5}}\n\n',
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()?.details).toEqual({ retryIn: 5 });
  });

  it('closes cleanly on a terminal-only stream carrying a null payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([`id: 1\nevent: terminal\ndata: ${JSON.stringify(null)}\n\n`])
    );
    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });
    expect(stream.status()).toBe('connecting');

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual([]);
    expect(stream.terminal()).toBeUndefined();
    expect(stream.error()).toBeUndefined();
    expect(stream.seq()).toBe(1);
  });

  it('reports a duration budget that expires before the first frame as the 504 envelope', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'STREAM_MAX_DURATION_EXCEEDED',
              message: 'The stream exceeded its declared duration budget',
            },
          }),
          { status: 504, headers: { 'content-type': 'application/json' } }
        )
    );

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toEqual({
      code: 'STREAM_MAX_DURATION_EXCEEDED',
      status: 504,
      message: 'The stream exceeded its declared duration budget',
    });
  });

  it('accepts a manifest operation that declares no terminal schema', async () => {
    const withoutTerminal: ShipStreamManifest = {
      ...manifest,
      operations: manifest.operations.map(operation =>
        operation.id === 'agent.run' && operation.response !== undefined
          ? { ...operation, response: { ...operation.response, terminal: undefined } }
          : operation
      ),
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse([
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        `id: 2\nevent: terminal\ndata: ${JSON.stringify(null)}\n\n`,
      ])
    );

    const stream = createStream<StreamContract, 'agent.run'>(
      { ...reference(), manifest: withoutTerminal },
      { fetch: fetchMock, platform: 'browser' }
    );

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual([{ delta: 'a' }]);
    expect(stream.terminal()).toBeUndefined();
  });

  it('ignores unknown event names and never sends a Last-Event-ID header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).has('last-event-id')).toBe(false);
      return sse([
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        'id: 2\nevent: diagnostic\ndata: {"ignored":true}\n\n',
        'id: 3\ndata: {"nameless":true}\n\n',
        'id: 4\nevent: terminal\ndata: {"tokens":1}\n\n',
      ]);
    });

    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: fetchMock,
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('closed');
    expect(stream.frames()).toEqual([{ delta: 'a' }]);
    expect(stream.seq()).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an interrupted stream',
      () => sse(['id: 1\nevent: frame\ndata: {"delta":"a"}\n\n']),
      'STREAM_INTERRUPTED',
    ],
    [
      'a protocol violation',
      () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'STREAM_PROTOCOL_VIOLATION',
    ],
  ])('reports %s locally with status 0', async (_label, respond, code) => {
    const stream = createStream<StreamContract, 'agent.run'>(reference(), {
      fetch: vi.fn<typeof fetch>(async () => respond()),
      platform: 'browser',
    });

    await expect(settle(stream.status)).resolves.toBe('error');
    expect(stream.error()).toMatchObject({ code, status: 0 });
  });

  it('settles an abort before the first frame on the handle without rejecting', async () => {
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRejection);
    try {
      const stream = createStream<StreamContract, 'agent.run'>(reference(), {
        fetch: vi.fn<typeof fetch>(async () => openSse([])),
        platform: 'browser',
      });
      await waitForStatus(stream.status, 'open');
      stream.abort();

      await expect(settle(stream.status)).resolves.toBe('aborted');
      expect(stream.frames()).toEqual([]);
      expect(stream.seq()).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });
});
