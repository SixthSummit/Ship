import {
  createOperationRequestPolicy,
  OperationAbortedError,
  type OperationPolicyMap,
  OperationTimeoutError,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationStream, type OperationStreamBinding } from './create-operation-stream';

interface StreamContract {
  readonly 'events.watch': {
    readonly input: { readonly query: { readonly channel: string } };
    readonly success: {
      readonly 200: { readonly sequence: number; readonly value: string };
      readonly 204: never;
    };
    readonly errors: 'AUTHENTICATION_ERROR' | 'UNAVAILABLE';
    readonly transport: 'stream';
  };
}

const policies: OperationPolicyMap<StreamContract> = {
  'events.watch': {
    authentication: 'optional',
    safety: 'safe',
    idempotency: 'unsupported',
    replayable: true,
    retry: { maxAttempts: 2, statuses: [503] },
    refreshAuthentication: true,
  },
};

const binding: OperationStreamBinding<StreamContract, 'events.watch'> = {
  request: input => ({
    url: `https://api.example.test/events?channel=${encodeURIComponent(input.query.channel)}`,
  }),
  successStatuses: [200, 204],
  declaredErrors: ['AUTHENTICATION_ERROR', 'UNAVAILABLE'],
  decode: frame => JSON.parse(frame.data) as { sequence: number; value: string },
};

function policy(
  overrides: Parameters<typeof createOperationRequestPolicy<StreamContract>>[0] = {
    policies,
  }
) {
  return createOperationRequestPolicy<StreamContract>({
    policies,
    allowedOrigins: ['https://api.example.test'],
    ...overrides,
  });
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
    { status, headers: { 'content-type': 'text/event-stream', ...headers } }
  );
}

function failure(status: number, code: string, headers: HeadersInit = {}): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code, message: code, details: { safe: true } } }),
    { status, headers: { 'content-type': 'application/json', ...headers } }
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createOperationStream', () => {
  it('is explicit, decodes split frames, retains metadata, and bounds event history', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
      });
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-current');
      return sse(
        [
          'id: event-1\ndata: {"sequence":1,"val',
          'ue":"one"}\n\ndata: {"sequence":2,"value":"two"}\n\n',
          'id: event-3\ndata: {"sequence":3,"value":"three"}\n\n',
        ],
        200,
        { 'x-request-id': 'request-server', etag: '"events-v1"' }
      );
    });
    const stream = createOperationStream(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken: async () => 'token-current' },
      }),
      'events.watch',
      binding,
      { fetch: fetchMock, maxEvents: 2 }
    );

    expect(stream.status()).toBe('idle');
    expect(stream.reload()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const terminal = await stream.start({ query: { channel: 'status updates' } });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/events?channel=status%20updates',
      expect.any(Object)
    );
    expect(terminal).toMatchObject({
      kind: 'closed',
      headers: { requestId: 'request-server', etag: '"events-v1"' },
      lastEventId: 'event-3',
    });
    expect(stream.events()).toEqual([
      { sequence: 2, value: 'two' },
      { sequence: 3, value: 'three' },
    ]);
    expect(stream.droppedEvents()).toBe(1);
    expect(stream.lastEventId()).toBe('event-3');
    expect(stream.headers()).toMatchObject({ requestId: 'request-server' });
    expect(stream.status()).toBe('closed');
    expect(stream.pending()).toBe(false);
    expect(stream.failure()).toBeUndefined();
    expect(stream.error()).toBeUndefined();
  });

  it('preserves declared and unknown pre-stream failures as expected values', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(failure(503, 'UNAVAILABLE'))
      .mockResolvedValueOnce(failure(409, 'NEW_SERVER_CODE'));
    const noRetryPolicies: OperationPolicyMap<StreamContract> = {
      'events.watch': { ...policies['events.watch'], retry: undefined },
    };
    const stream = createOperationStream(
      policy({ policies: noRetryPolicies, allowedOrigins: ['https://api.example.test'] }),
      'events.watch',
      binding,
      { fetch: fetchMock }
    );

    await expect(stream.start({ query: { channel: 'one' } })).resolves.toMatchObject({
      kind: 'failure',
      result: { ok: false, status: 503, error: { declared: true, code: 'UNAVAILABLE' } },
    });
    expect(stream.status()).toBe('failure');
    expect(stream.failure()).toMatchObject({ status: 503 });

    await expect(stream.start({ query: { channel: 'two' } })).resolves.toMatchObject({
      kind: 'failure',
      result: { error: { declared: false, code: 'NEW_SERVER_CODE' } },
    });
  });

  it('distinguishes proxy failures, invalid success MIME, body, status, and events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(
        new Response('not sse', { status: 200, headers: { 'content-type': 'text/plain' } })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
      .mockResolvedValueOnce(sse([], 201))
      .mockResolvedValueOnce(sse(['data: not-json\n\n']));
    const stream = createOperationStream(policy(), 'events.watch', binding, { fetch: fetchMock });

    await expect(stream.start({ query: { channel: 'proxy' } })).rejects.toMatchObject({
      reason: 'unexpected-content-type',
      status: 502,
    });
    await expect(stream.start({ query: { channel: 'mime' } })).rejects.toMatchObject({
      reason: 'unexpected-content-type',
      receivedContentType: 'text/plain',
    });
    await expect(stream.start({ query: { channel: 'body' } })).rejects.toMatchObject({
      reason: 'invalid-envelope',
    });
    await expect(stream.start({ query: { channel: 'status' } })).rejects.toMatchObject({
      reason: 'unexpected-status',
      status: 201,
    });
    await expect(stream.start({ query: { channel: 'event' } })).rejects.toMatchObject({
      reason: 'invalid-event',
    });
    expect(stream.error()).toBeInstanceOf(ProtocolError);
  });

  it('treats a declared 204 as normal completion without requiring a body or reconnect', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const reconnectingBinding: OperationStreamBinding<StreamContract, 'events.watch'> = {
      ...binding,
      reconnect: { maxAttempts: 3, on: ['normal'] },
    };
    const stream = createOperationStream(policy(), 'events.watch', reconnectingBinding, {
      fetch: fetchMock,
    });

    await expect(stream.start({ query: { channel: 'done' } })).resolves.toMatchObject({
      kind: 'closed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stream.status()).toBe('closed');
  });

  it('uses operation retry and auth refresh before a stream opens', async () => {
    const delay = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const tokens: Array<string | null> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        return failure(401, 'AUTHENTICATION_ERROR');
      })
      .mockImplementationOnce(async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        return failure(503, 'UNAVAILABLE', { 'retry-after': '1' });
      })
      .mockImplementationOnce(async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        return sse(['data: {"sequence":1,"value":"open"}\n\n']);
      });
    const stream = createOperationStream(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken, refresh },
        requestId: { generate: () => 'one-logical-request' },
      }),
      'events.watch',
      binding,
      { fetch: fetchMock, delay }
    );

    await stream.start({ query: { channel: 'retry' } });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3']);
    expect(delay).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get('x-request-id')).toBe('one-logical-request');
    }
  });

  it('reconnects only when declared and forwards sticky event ID with fresh credentials', async () => {
    const delay = vi.fn(async () => undefined);
    const getToken = vi.fn(async ({ attempt }: { attempt: number }) => `token-${attempt}`);
    const captured: Array<{ token: string | null; lastId: string | null }> = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        const headers = new Headers(init?.headers);
        captured.push({
          token: headers.get('authorization'),
          lastId: headers.get('last-event-id'),
        });
        return sse(['id: sticky-1\nretry: 25\ndata: {"sequence":1,"value":"one"}\n\n']);
      })
      .mockImplementationOnce(async (_url, init) => {
        const headers = new Headers(init?.headers);
        captured.push({
          token: headers.get('authorization'),
          lastId: headers.get('last-event-id'),
        });
        return sse(['data: {"sequence":2,"value":"two"}\n\n']);
      });
    const reconnectingBinding: OperationStreamBinding<StreamContract, 'events.watch'> = {
      ...binding,
      reconnect: { maxAttempts: 1, on: ['normal'], baseDelayMs: 100 },
    };
    const stream = createOperationStream(
      policy({
        policies,
        allowedOrigins: ['https://api.example.test'],
        credentials: { kind: 'bearer', getToken },
      }),
      'events.watch',
      reconnectingBinding,
      { fetch: fetchMock, delay }
    );

    await stream.start({ query: { channel: 'reconnect' } });

    expect(captured).toEqual([
      { token: 'Bearer token-1', lastId: null },
      { token: 'Bearer token-2', lastId: 'sticky-1' },
    ]);
    expect(delay).toHaveBeenCalledWith(25, expect.any(AbortSignal));
    expect(stream.events()).toHaveLength(2);
  });

  it('reconnects after a reader network failure but never after a protocol failure', async () => {
    const brokenBody = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError('socket reset secret');
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(brokenBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
      .mockResolvedValueOnce(sse(['data: {"sequence":2,"value":"recovered"}\n\n']));
    const reconnectingBinding: OperationStreamBinding<StreamContract, 'events.watch'> = {
      ...binding,
      reconnect: { maxAttempts: 1, on: ['network'], baseDelayMs: 0 },
    };
    const stream = createOperationStream(policy(), 'events.watch', reconnectingBinding, {
      fetch: fetchMock,
      delay: async () => undefined,
    });

    await stream.start({ query: { channel: 'reader' } });
    expect(stream.events()).toEqual([{ sequence: 2, value: 'recovered' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const invalid = createOperationStream(policy(), 'events.watch', reconnectingBinding, {
      fetch: async () => sse(['data: invalid\n\n']),
      delay: async () => undefined,
    });
    await expect(invalid.start({ query: { channel: 'invalid' } })).rejects.toMatchObject({
      reason: 'invalid-event',
    });
  });

  it('normalizes fetch failures without leaking details when reconnect is unavailable', async () => {
    const stream = createOperationStream(policy(), 'events.watch', binding, {
      fetch: async () => Promise.reject(new TypeError('private proxy address')),
    });

    const rejection = await stream.start({ query: { channel: 'network' } }).catch(error => error);

    expect(rejection).toBeInstanceOf(TransportError);
    expect(rejection).toMatchObject({ reason: 'network', causeName: 'TypeError' });
    expect(JSON.stringify(rejection)).not.toContain('private proxy address');
    expect(stream.status()).toBe('error');
  });

  it('cancels reader work and distinguishes an overall timeout', async () => {
    const cancel = vi.fn();
    const openResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"sequence":1,"value":"open"}\n\n'));
          },
          cancel,
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    const stream = createOperationStream(policy(), 'events.watch', binding, {
      fetch: async () => openResponse(),
    });
    const pending = stream.start({ query: { channel: 'cancel' } });
    const cancelAssertion = expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    await vi.waitFor(() => expect(stream.status()).toBe('open'));
    expect(stream.cancel()).toBe(true);
    await cancelAssertion;
    expect(stream.status()).toBe('aborted');
    expect(stream.cancel()).toBe(false);
    expect(cancel).toHaveBeenCalled();

    vi.useFakeTimers();
    const timeout = createOperationStream(policy(), 'events.watch', binding, {
      fetch: async () => openResponse(),
    });
    const timed = timeout.start({ query: { channel: 'timeout' } }, { timeoutMs: 10 });
    const timeoutAssertion = expect(timed).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await timeoutAssertion;
    expect(timeout.status()).toBe('error');
  });

  it('reloads explicitly and reset/destroy prevent stale work from mutating state', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(['data: {"sequence":1,"value":"one"}\n\n']))
      .mockResolvedValueOnce(sse(['data: {"sequence":2,"value":"two"}\n\n']));
    const stream = createOperationStream(policy(), 'events.watch', binding, { fetch: fetchMock });
    await stream.start({ query: { channel: 'reload' } });
    await stream.reload();
    expect(stream.events()).toEqual([{ sequence: 2, value: 'two' }]);

    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"sequence":3,"value":"stale"}\n\n'));
      },
    });
    const pendingStream = createOperationStream(policy(), 'events.watch', binding, {
      fetch: async () => new Response(open, { headers: { 'content-type': 'text/event-stream' } }),
    });
    const pending = pendingStream.start({ query: { channel: 'stale' } });
    const resetAssertion = expect(pending).rejects.toBeInstanceOf(OperationAbortedError);
    await vi.waitFor(() => expect(pendingStream.status()).toBe('open'));
    pendingStream.reset();
    await resetAssertion;
    expect(pendingStream.status()).toBe('idle');
    expect(pendingStream.events()).toEqual([]);
    expect(pendingStream.reload()).toBe(false);
    pendingStream.destroy();
    expect(pendingStream.status()).toBe('aborted');
  });

  it('validates configuration and contains generated serializer failures', async () => {
    expect(() =>
      createOperationStream(policy(), 'events.watch', binding, { maxEvents: 0 })
    ).toThrow(RangeError);
    expect(() =>
      createOperationStream(
        policy(),
        'events.watch',
        { ...binding, reconnect: { maxAttempts: -1, on: ['normal'] } },
        {}
      )
    ).toThrow(RangeError);

    const broken: OperationStreamBinding<StreamContract, 'events.watch'> = {
      ...binding,
      request: () => {
        throw new Error('generated private detail');
      },
    };
    const stream = createOperationStream(policy(), 'events.watch', broken);
    await expect(stream.start({ query: { channel: 'broken' } })).rejects.toMatchObject({
      name: 'ProtocolError',
      reason: 'invalid-envelope',
    });
  });
});
