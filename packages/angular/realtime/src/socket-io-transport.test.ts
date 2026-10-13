import { describe, expect, it } from 'vitest';
import type {
  RealtimeDroppedFrame,
  RealtimeEventFrame,
  RealtimePresenceFrame,
  ShipRealtimeTransportHandlers,
} from './realtime-transport';
import { RealtimeConnectError } from './realtime-transport';
import { createSocketIoTransport, type SocketIoLoader } from './socket-io-transport';

interface FakeSocket {
  readonly listeners: Map<string, (value: unknown) => void>;
  readonly emitted: { event: string; payload: unknown; timeoutMs: number }[];
  disconnected: boolean;
  respond(value: unknown, error?: unknown): void;
}

interface FakeIo {
  readonly loader: SocketIoLoader;
  readonly sockets: FakeSocket[];
  readonly calls: { uri: string; options: Readonly<Record<string, unknown>> }[];
}

function fakeIo(): FakeIo {
  const sockets: FakeSocket[] = [];
  const calls: { uri: string; options: Readonly<Record<string, unknown>> }[] = [];
  const loader: SocketIoLoader = async () => (uri, options) => {
    calls.push({ uri, options });
    const acks: ((error: unknown, response?: unknown) => void)[] = [];
    const socket: FakeSocket = {
      listeners: new Map(),
      emitted: [],
      disconnected: false,
      respond: (value: unknown, error: unknown = null) => {
        const ack = acks.shift();
        if (ack === undefined) throw new Error('No pending ack');
        ack(error, value);
      },
    };
    sockets.push(socket);
    return {
      on: (event: string, handler: (...args: never[]) => void) => {
        socket.listeners.set(event, handler as unknown as (value: unknown) => void);
        return undefined;
      },
      timeout: (timeoutMs: number) => ({
        emit: (event: string, payload: unknown, ack) => {
          socket.emitted.push({ event, payload, timeoutMs });
          acks.push(ack);
          return undefined;
        },
      }),
      disconnect: () => {
        socket.disconnected = true;
        return undefined;
      },
    };
  };
  return { loader, sockets, calls };
}

function collector(): {
  readonly handlers: ShipRealtimeTransportHandlers;
  readonly events: RealtimeEventFrame[];
  readonly presence: RealtimePresenceFrame[];
  readonly dropped: RealtimeDroppedFrame[];
  readonly disconnects: string[];
} {
  const events: RealtimeEventFrame[] = [];
  const presence: RealtimePresenceFrame[] = [];
  const dropped: RealtimeDroppedFrame[] = [];
  const disconnects: string[] = [];
  return {
    events,
    presence,
    dropped,
    disconnects,
    handlers: {
      onEvent: frame => events.push(frame),
      onPresence: frame => presence.push(frame),
      onDropped: frame => dropped.push(frame),
      onDisconnect: reason => disconnects.push(reason),
    },
  };
}

async function connect(io: FakeIo, sink = collector(), url = 'https://gateway.test/') {
  const transport = createSocketIoTransport(io.loader);
  const pending = transport({
    url,
    credential: 'token-1',
    ackTimeoutMs: 1_234,
    handlers: sink.handlers,
  });
  await Promise.resolve();
  const socket = io.sockets.at(-1);
  if (socket === undefined) throw new Error('The adapter did not construct a socket');
  socket.listeners.get('connect')?.(undefined);
  return { connection: await pending, socket, sink };
}

describe('createSocketIoTransport', () => {
  it('connects to the /ship namespace with the supplied credential', async () => {
    const io = fakeIo();
    await connect(io);

    expect(io.calls[0]?.uri).toBe('https://gateway.test/ship');
    expect(io.calls[0]?.options).toMatchObject({
      auth: { credential: 'token-1' },
      reconnection: false,
    });
  });

  it('keeps an explicit gateway path intact', async () => {
    const io = fakeIo();
    await connect(io, collector(), 'https://gateway.test');
    expect(io.calls[0]?.uri).toBe('https://gateway.test/ship');
  });

  it.each([
    ['AUTHENTICATION_ERROR'],
    ['AUTHORIZATION_ERROR'],
    ['AUTHENTICATION_UNAVAILABLE'],
  ] as const)('classifies a %s refusal', async code => {
    const io = fakeIo();
    const transport = createSocketIoTransport(io.loader);
    const pending = transport({
      url: 'https://gateway.test',
      credential: 'token-1',
      ackTimeoutMs: 100,
      handlers: collector().handlers,
    });
    await Promise.resolve();
    const socket = io.sockets[0];
    socket?.listeners.get('connect_error')?.({ data: { code, message: 'refused' } });

    await expect(pending).rejects.toMatchObject({ code, message: 'refused' });
    expect(socket?.disconnected).toBe(true);
  });

  it('classifies an unlabelled connect failure as a transport error', async () => {
    const io = fakeIo();
    const transport = createSocketIoTransport(io.loader);
    const pending = transport({
      url: 'https://gateway.test',
      credential: 'token-1',
      ackTimeoutMs: 100,
      handlers: collector().handlers,
    });
    await Promise.resolve();
    io.sockets[0]?.listeners.get('connect_error')?.(new Error('xhr poll error'));

    await expect(pending).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR',
      message: 'xhr poll error',
    });
  });

  it('decodes subscribe, unsubscribe, and presence acks', async () => {
    const io = fakeIo();
    const { connection, socket } = await connect(io);

    const subscribe = connection.subscribe({ channel: 'room.messages', scopeKey: 'room-7' });
    expect(socket.emitted[0]).toEqual({
      event: 'ship:subscribe',
      payload: { channel: 'room.messages', scopeKey: 'room-7' },
      timeoutMs: 1_234,
    });
    socket.respond({ ok: true, subscriptionId: 'subscription-1' });
    await expect(subscribe).resolves.toEqual({ ok: true, subscriptionId: 'subscription-1' });

    const refused = connection.subscribe({ channel: 'room.messages', scopeKey: 'room-8' });
    socket.respond({ ok: false, code: 'SUBSCRIPTION_FORBIDDEN', message: 'no' });
    await expect(refused).resolves.toEqual({
      ok: false,
      code: 'SUBSCRIPTION_FORBIDDEN',
      message: 'no',
    });

    const unsubscribe = connection.unsubscribe({ subscriptionId: 'subscription-1' });
    socket.respond({ ok: true });
    await expect(unsubscribe).resolves.toEqual({ ok: true });

    const unknown = connection.unsubscribe({ subscriptionId: 'gone' });
    socket.respond({ ok: false, code: 'UNKNOWN_SUBSCRIPTION' });
    await expect(unknown).resolves.toEqual({
      ok: false,
      code: 'UNKNOWN_SUBSCRIPTION',
      message: '',
    });

    const presence = connection.presenceSnapshot({
      channel: 'room.messages',
      scopeKey: 'room-7',
    });
    socket.respond({ ok: true, count: 2, members: ['actor-1', 7, 'actor-2'] });
    await expect(presence).resolves.toEqual({
      ok: true,
      count: 2,
      members: ['actor-1', 'actor-2'],
    });

    const disabled = connection.presenceSnapshot({
      channel: 'account.updated',
      scopeKey: 'actor-1',
    });
    socket.respond({ ok: false, code: 'PRESENCE_DISABLED', message: 'off' });
    await expect(disabled).resolves.toEqual({
      ok: false,
      code: 'PRESENCE_DISABLED',
      message: 'off',
    });
  });

  it.each([
    ['subscribe', (value: unknown) => value],
    ['unsubscribe', (value: unknown) => value],
    ['presence', (value: unknown) => value],
  ])('rejects a malformed %s ack', async name => {
    const io = fakeIo();
    const { connection, socket } = await connect(io);
    const pending =
      name === 'subscribe'
        ? connection.subscribe({ channel: 'c', scopeKey: 's' })
        : name === 'unsubscribe'
          ? connection.unsubscribe({ subscriptionId: 'x' })
          : connection.presenceSnapshot({ channel: 'c', scopeKey: 's' });
    socket.respond({ nonsense: true });
    await expect(pending).rejects.toBeInstanceOf(RealtimeConnectError);
  });

  it('rejects when an ack times out', async () => {
    const io = fakeIo();
    const { connection, socket } = await connect(io);
    const pending = connection.subscribe({ channel: 'c', scopeKey: 's' });
    socket.respond(undefined, new Error('operation has timed out'));
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  });

  it('forwards well-formed frames and drops malformed ones', async () => {
    const io = fakeIo();
    const { socket, sink } = await connect(io);

    socket.listeners.get('ship:event')?.({
      channel: 'room.messages',
      scopeKey: 'room-7',
      seq: 1,
      publishedAt: '2026-09-18T10:00:00.000Z',
      payload: { text: 'hi' },
    });
    socket.listeners.get('ship:event')?.({ channel: 'room.messages' });
    socket.listeners.get('ship:presence')?.({
      channel: 'room.messages',
      scopeKey: 'room-7',
      kind: 'joined',
      actorId: 'actor-1',
      count: 1,
    });
    socket.listeners.get('ship:presence')?.({ channel: 'room.messages', kind: 'waved' });
    socket.listeners.get('ship:dropped')?.({
      channel: 'room.messages',
      scopeKey: 'room-7',
      dropped: 4,
    });
    socket.listeners.get('ship:dropped')?.('nope');
    socket.listeners.get('disconnect')?.('ship:slow-subscriber');
    socket.listeners.get('disconnect')?.(undefined);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.payload).toEqual({ text: 'hi' });
    expect(sink.presence).toHaveLength(1);
    expect(sink.dropped).toEqual([{ channel: 'room.messages', scopeKey: 'room-7', dropped: 4 }]);
    expect(sink.disconnects).toEqual(['ship:slow-subscriber', 'transport error']);
  });

  it('disconnects the socket on close', async () => {
    const io = fakeIo();
    const { connection, socket } = await connect(io);
    connection.close();
    expect(socket.disconnected).toBe(true);
  });
});
