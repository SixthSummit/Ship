import {
  EMPTY_RESPONSE_METADATA,
  OperationAbortedError,
  type OperationClient,
  type OperationResult,
  ProtocolError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationSocket, type OperationSocketBinding } from './create-operation-socket';

interface SocketContract {
  readonly 'notifications.ticket': {
    readonly input: { readonly body: { readonly workspaceId: string } };
    readonly success: { readonly 201: { readonly ticket: string } };
    readonly errors: 'AUTHENTICATION_ERROR';
    readonly transport: 'http';
  };
  readonly 'notifications.socket': {
    readonly input: { readonly query: { readonly workspaceId: string } };
    readonly success: {
      readonly 101: { readonly type: 'notification'; readonly id: string };
    };
    readonly errors: 'CONNECTION_DENIED';
    readonly transport: 'socket';
  };
}

interface ClientMessage {
  readonly type: 'ack';
  readonly id: string;
}

const binding: OperationSocketBinding<
  SocketContract,
  'notifications.socket',
  ClientMessage,
  'notifications.ticket'
> = {
  ticket: {
    operation: 'notifications.ticket',
    input: input => ({ body: { workspaceId: input.query.workspaceId } }),
  },
  connection: (input, ticket) => ({
    url: `wss://socket.example.test/notifications?workspace=${input.query.workspaceId}&ticket=${ticket.ticket}`,
    protocols: ['ship-api.notifications.v2', `ticket.${ticket.ticket}`],
  }),
  decode: event => {
    const value = JSON.parse(String(event.data)) as { type?: string; id?: string };
    if (value.type !== 'notification' || typeof value.id !== 'string') throw new TypeError();
    return { type: value.type, id: value.id };
  },
  encode: message => JSON.stringify(message),
  cleanCloseCodes: [1000, 1001],
  reconnectCloseCodes: [1006, 1012],
  reconnect: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
  requireProtocol: true,
  protocolErrorCloseCode: 4002,
};

const ticketSuccess = (ticket: string) =>
  ({
    ok: true,
    status: 201,
    data: { ticket },
    headers: EMPTY_RESPONSE_METADATA,
  }) as const;

function clientFrom(
  handler: (
    input: { readonly body: { readonly workspaceId: string } },
    signal: AbortSignal | undefined
  ) => Promise<OperationResult<{ readonly ticket: string }, 'AUTHENTICATION_ERROR'>>
): OperationClient<SocketContract> {
  return {
    call: ((
      _operation: 'notifications.ticket',
      input: { body: { workspaceId: string } },
      options?: { signal?: AbortSignal }
    ) => handler(input, options?.signal)) as OperationClient<SocketContract>['call'],
  };
}

class MockSocket {
  static readonly instances: MockSocket[] = [];
  readyState = 0;
  protocol = '';
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: readonly string[]
  ) {
    MockSocket.instances.push(this);
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException('Invalid close code', 'InvalidAccessError');
    this.readyState = 2;
    this.closes.push({ code, reason });
  }

  open(protocol = this.protocols[0] ?? ''): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  closed(code: number, reason = '', wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }
}

const createWebSocket = (url: string, protocols: readonly string[]): WebSocket =>
  new MockSocket(url, protocols) as unknown as WebSocket;
const lastSocket = (): MockSocket => MockSocket.instances[MockSocket.instances.length - 1]!;
const socketInput = { query: { workspaceId: 'workspace-1' } } as const;

beforeEach(() => {
  MockSocket.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createOperationSocket', () => {
  it('rejects invalid browser close codes and preserves ticket cancellation', async () => {
    const call = vi.fn(async () => ticketSuccess('ticket'));
    const options = { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket };
    expect(() =>
      createOperationSocket(clientFrom(call), { ...binding, protocolErrorCloseCode: 1002 }, options)
    ).toThrow(RangeError);
    const caller = new AbortController();
    caller.abort();
    const socket = createOperationSocket(clientFrom(call), binding, options);
    await expect(
      socket.connect(socketInput, { ticket: { signal: caller.signal } })
    ).rejects.toBeInstanceOf(OperationAbortedError);
    expect(call).not.toHaveBeenCalled();
    expect(MockSocket.instances).toHaveLength(0);
  });
  it('is explicit, obtains a ticket, validates protocol, and bounds decoded message history', async () => {
    const ticketCalls: Array<{ input: unknown; signal?: AbortSignal }> = [];
    const client = clientFrom(async (input, signal) => {
      ticketCalls.push({ input, signal });
      return ticketSuccess('ticket-1');
    });
    const socket = createOperationSocket(client, binding, {
      allowedSocketOrigins: ['wss://socket.example.test'],
      createWebSocket,
      maxMessages: 2,
    });

    expect(socket.status()).toBe('idle');
    expect(socket.reconnect()).toBe(false);
    expect(MockSocket.instances).toHaveLength(0);
    await expect(socket.connect(socketInput)).resolves.toEqual({ ok: true });
    expect(ticketCalls).toEqual([
      {
        input: { body: { workspaceId: 'workspace-1' } },
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(lastSocket().url).toBe(
      'wss://socket.example.test/notifications?workspace=workspace-1&ticket=ticket-1'
    );
    expect(lastSocket().protocols).toEqual(['ship-api.notifications.v2', 'ticket.ticket-1']);
    expect(socket.status()).toBe('connecting');
    lastSocket().open();
    expect(socket.status()).toBe('open');
    lastSocket().message({ type: 'notification', id: '1' });
    lastSocket().message({ type: 'notification', id: '2' });
    lastSocket().message({ type: 'notification', id: '3' });
    expect(socket.messages()).toEqual([
      { type: 'notification', id: '2' },
      { type: 'notification', id: '3' },
    ]);
    expect(socket.droppedMessages()).toBe(1);
    expect(socket.error()).toBeUndefined();
    expect(socket.ticketFailure()).toBeUndefined();
  });

  it('returns explicit send results and enforces a bounded connecting queue', async () => {
    const socket = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
        sendWhileConnecting: 'queue',
        maxQueuedSends: 1,
      }
    );
    expect(socket.send({ type: 'ack', id: 'before' })).toEqual({
      ok: false,
      reason: 'not-open',
    });
    const connecting = socket.connect(socketInput);
    expect(socket.send({ type: 'ack', id: 'queued' })).toEqual({ ok: true, queued: true });
    expect(socket.send({ type: 'ack', id: 'overflow' })).toEqual({
      ok: false,
      reason: 'queue-full',
    });
    await connecting;
    expect(socket.queuedSends()).toBe(1);
    lastSocket().open();
    expect(lastSocket().sent).toEqual([JSON.stringify({ type: 'ack', id: 'queued' })]);
    expect(socket.queuedSends()).toBe(0);
    expect(socket.send({ type: 'ack', id: 'now' })).toEqual({ ok: true, queued: false });
    expect(lastSocket().sent[1]).toBe(JSON.stringify({ type: 'ack', id: 'now' }));

    const rejectQueue = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-2')),
      binding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    const pending = rejectQueue.connect(socketInput);
    expect(rejectQueue.send({ type: 'ack', id: 'drop' })).toEqual({
      ok: false,
      reason: 'not-open',
    });
    await pending;
  });

  it('contains outgoing and incoming codec failures as protocol errors', async () => {
    const brokenBinding: OperationSocketBinding<
      SocketContract,
      'notifications.socket',
      ClientMessage,
      'notifications.ticket'
    > = {
      ...binding,
      encode: () => {
        throw new TypeError('private outgoing value');
      },
    };
    const outgoing = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      brokenBinding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    await outgoing.connect(socketInput);
    lastSocket().open();
    expect(outgoing.send({ type: 'ack', id: 'bad' })).toEqual({
      ok: false,
      reason: 'encode-failed',
    });
    expect(outgoing.error()).toBeInstanceOf(ProtocolError);

    const incoming = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-2')),
      binding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    await incoming.connect(socketInput);
    lastSocket().open();
    lastSocket().message({ type: 'unknown' });
    expect(incoming.status()).toBe('error');
    expect(incoming.error()).toMatchObject({ reason: 'invalid-message' });
    expect(lastSocket().closes).toContainEqual({ code: 4002, reason: 'invalid message' });
  });

  it('surfaces an expected ticket failure and rejects cached tickets', async () => {
    const failure = {
      ok: false,
      status: 401,
      error: { declared: true, code: 'AUTHENTICATION_ERROR', message: 'Sign in' },
      headers: EMPTY_RESPONSE_METADATA,
    } as const;
    const denied = createOperationSocket(
      clientFrom(async () => failure),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await expect(denied.connect(socketInput)).resolves.toMatchObject({
      ok: false,
      stage: 'ticket',
      result: { status: 401, error: { code: 'AUTHENTICATION_ERROR' } },
    });
    expect(denied.status()).toBe('failure');
    expect(denied.ticketFailure()).toMatchObject({ status: 401 });
    expect(MockSocket.instances).toHaveLength(0);

    const cached = createOperationSocket(
      clientFrom(async () => ({
        ok: true,
        notModified: true,
        status: 304,
        headers: EMPTY_RESPONSE_METADATA,
      })),
      binding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    await expect(cached.connect(socketInput)).rejects.toMatchObject({
      reason: 'unexpected-status',
      status: 304,
    });
  });

  it('reissues a current ticket on each declared reconnect and enforces the cap', async () => {
    vi.useFakeTimers();
    let ticketNumber = 0;
    const client = clientFrom(async () => ticketSuccess(`ticket-${++ticketNumber}`));
    const socket = createOperationSocket(client, binding, {
      allowedSocketOrigins: ['wss://socket.example.test'],
      createWebSocket,
    });
    await socket.connect(socketInput);
    lastSocket().closed(1006, 'restart');
    expect(socket.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(MockSocket.instances).toHaveLength(2);
    expect(lastSocket().protocols).toContain('ticket.ticket-2');
    lastSocket().closed(1006);
    await vi.advanceTimersByTimeAsync(20);
    expect(MockSocket.instances).toHaveLength(3);
    expect(lastSocket().protocols).toContain('ticket.ticket-3');
    lastSocket().closed(1006);
    await vi.advanceTimersByTimeAsync(100);
    expect(MockSocket.instances).toHaveLength(3);
    expect(socket.status()).toBe('closed');
  });

  it('continues an approved reconnect sequence after a constructor transport failure', async () => {
    vi.useFakeTimers();
    let factoryAttempt = 0;
    const factory = (url: string, protocols: readonly string[]): WebSocket => {
      factoryAttempt += 1;
      if (factoryAttempt === 2) throw new TypeError('ephemeral constructor detail');
      return createWebSocket(url, protocols);
    };
    const socket = createOperationSocket(
      clientFrom(async () => ticketSuccess(`ticket-${factoryAttempt + 1}`)),
      binding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket: factory }
    );
    await socket.connect(socketInput);
    lastSocket().closed(1006);

    await vi.advanceTimersByTimeAsync(10);
    expect(socket.status()).toBe('reconnecting');
    expect(socket.error()).toBeInstanceOf(TransportError);
    await vi.advanceTimersByTimeAsync(20);

    expect(MockSocket.instances).toHaveLength(2);
    expect(socket.status()).toBe('reconnecting');
  });

  it('does not reconnect clean or undeclared close codes and retains close metadata', async () => {
    vi.useFakeTimers();
    const clean = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await clean.connect(socketInput);
    lastSocket().open();
    lastSocket().closed(1000, 'complete', true);
    expect(clean.status()).toBe('closed');
    expect(clean.closeInfo()).toEqual({ code: 1000, reason: 'complete', wasClean: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(MockSocket.instances).toHaveLength(1);

    const unlisted = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-2')),
      binding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    await unlisted.connect(socketInput);
    lastSocket().closed(4000, 'app close');
    expect(unlisted.status()).toBe('closed');
    await vi.advanceTimersByTimeAsync(100);
    expect(MockSocket.instances).toHaveLength(2);
  });

  it('requires a declared negotiated protocol when configured', async () => {
    const socket = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await socket.connect(socketInput);
    lastSocket().open('undeclared.protocol');
    expect(socket.status()).toBe('error');
    expect(socket.error()).toMatchObject({ reason: 'invalid-message' });
    expect(lastSocket().closes).toContainEqual({ code: 4002, reason: 'protocol error' });
  });

  it('blocks non-WebSocket origins, credential query names, duplicates, and redirected origins', async () => {
    expect(() =>
      createOperationSocket(
        clientFrom(async () => ticketSuccess('x')),
        binding,
        {
          allowedSocketOrigins: [],
          createWebSocket,
        }
      )
    ).toThrow(RangeError);
    expect(() =>
      createOperationSocket(
        clientFrom(async () => ticketSuccess('x')),
        binding,
        {
          allowedSocketOrigins: ['https://socket.example.test'],
          createWebSocket,
        }
      )
    ).toThrow(RangeError);

    const cases = [
      { url: 'wss://other.example.test/path', protocols: ['v1'] },
      { url: 'wss://socket.example.test/path?access_token=secret', protocols: ['v1'] },
      { url: 'wss://socket.example.test/path', protocols: ['v1', 'v1'] },
      { url: '/relative', protocols: ['v1'] },
    ];
    for (const connection of cases) {
      const invalidBinding = {
        ...binding,
        connection: () => connection,
      } satisfies OperationSocketBinding<
        SocketContract,
        'notifications.socket',
        ClientMessage,
        'notifications.ticket'
      >;
      const socket = createOperationSocket(
        clientFrom(async () => ticketSuccess('ticket-1')),
        invalidBinding,
        { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
      );
      await expect(socket.connect(socketInput)).rejects.toBeInstanceOf(ProtocolError);
    }
    expect(MockSocket.instances).toHaveLength(0);
  });

  it('remains inert in SSR and contains constructor details', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const inert = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
      }
    );
    await expect(inert.connect(socketInput)).resolves.toEqual({
      ok: false,
      stage: 'runtime',
      reason: 'unavailable',
    });
    expect(inert.status()).toBe('idle');

    const throwing = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket: () => {
          throw new TypeError('provider secret detail');
        },
      }
    );
    const rejection = await throwing.connect(socketInput).catch(error => error);
    expect(rejection).toMatchObject({
      name: 'TransportError',
      reason: 'connection',
      causeName: 'TypeError',
    });
    expect(JSON.stringify(rejection)).not.toContain('provider secret detail');
  });

  it('supports an explicit cookie-handshake binding without a ticket operation', async () => {
    const noTicketBinding: OperationSocketBinding<
      SocketContract,
      'notifications.socket',
      ClientMessage
    > = {
      connection: (input, ticket) => {
        expect(ticket).toBeUndefined();
        return {
          url: `wss://socket.example.test/cookie?workspace=${input.query.workspaceId}`,
          protocols: ['ship-api.notifications.v2'],
        };
      },
      decode: binding.decode,
      encode: binding.encode,
      cleanCloseCodes: [1000],
      reconnectCloseCodes: [],
    };
    const call = vi.fn();
    const socket = createOperationSocket(
      { call: call as OperationClient<SocketContract>['call'] },
      noTicketBinding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );

    await expect(socket.connect(socketInput)).resolves.toEqual({ ok: true });
    expect(call).not.toHaveBeenCalled();
    expect(lastSocket().url).toContain('/cookie?workspace=workspace-1');
  });

  it('reports socket errors and supports explicit close and reconnect', async () => {
    const socket = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await socket.connect(socketInput);
    lastSocket().open();
    lastSocket().fail();
    expect(socket.error()).toBeInstanceOf(TransportError);
    socket.close(1000, 'done');
    expect(socket.status()).toBe('closing');
    lastSocket().closed(1000, 'done', true);
    expect(socket.status()).toBe('closed');
    await expect(socket.reconnect()).resolves.toEqual({ ok: true });
    expect(MockSocket.instances).toHaveLength(2);
  });

  it('external abort, reset, and destroy cancel sockets and reconnect timers', async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    const socket = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-1')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
        signal: lifecycle.signal,
      }
    );
    await socket.connect(socketInput);
    const first = lastSocket();
    lifecycle.abort();
    expect(first.closes).toContainEqual({ code: 1000, reason: 'aborted' });
    expect(socket.error()).toBeInstanceOf(OperationAbortedError);

    socket.reset();
    expect(socket.status()).toBe('idle');
    expect(socket.messages()).toEqual([]);
    expect(socket.reconnect()).toBe(false);

    const active = createOperationSocket(
      clientFrom(async () => ticketSuccess('ticket-2')),
      binding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await active.connect(socketInput);
    lastSocket().closed(1006);
    active.destroy();
    await vi.advanceTimersByTimeAsync(100);
    expect(active.status()).toBe('closed');
    expect(MockSocket.instances).toHaveLength(2);
  });

  it('validates queue/history/reconnect configuration and contains generated metadata failures', async () => {
    expect(() =>
      createOperationSocket(
        clientFrom(async () => ticketSuccess('x')),
        binding,
        {
          allowedSocketOrigins: ['wss://socket.example.test'],
          createWebSocket,
          maxMessages: 0,
        }
      )
    ).toThrow(RangeError);
    expect(() =>
      createOperationSocket(
        clientFrom(async () => ticketSuccess('x')),
        { ...binding, reconnect: { maxAttempts: -1 } },
        { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
      )
    ).toThrow(RangeError);

    const ticketBinding = {
      ...binding,
      ticket: {
        operation: 'notifications.ticket' as const,
        input: () => {
          throw new Error('ticket input private');
        },
      },
    } satisfies OperationSocketBinding<
      SocketContract,
      'notifications.socket',
      ClientMessage,
      'notifications.ticket'
    >;
    const ticket = createOperationSocket(
      clientFrom(async () => ticketSuccess('x')),
      ticketBinding,
      {
        allowedSocketOrigins: ['wss://socket.example.test'],
        createWebSocket,
      }
    );
    await expect(ticket.connect(socketInput)).rejects.toMatchObject({ reason: 'invalid-envelope' });

    const connectionBinding = {
      ...binding,
      connection: () => {
        throw new Error('connection private');
      },
    } satisfies OperationSocketBinding<
      SocketContract,
      'notifications.socket',
      ClientMessage,
      'notifications.ticket'
    >;
    const connection = createOperationSocket(
      clientFrom(async () => ticketSuccess('x')),
      connectionBinding,
      { allowedSocketOrigins: ['wss://socket.example.test'], createWebSocket }
    );
    await expect(connection.connect(socketInput)).rejects.toMatchObject({
      reason: 'invalid-envelope',
    });
  });
});
