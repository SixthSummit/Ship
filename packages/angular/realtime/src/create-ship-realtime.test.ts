import { describe, expect, it } from 'vitest';
import { createShipRealtime, type ShipRealtimeRuntime } from './create-ship-realtime';
import {
  channelsPublishedBy,
  indexRealtimeChannels,
  type RealtimeManifest,
} from './realtime-contract';
import type { RealtimeEvent } from './realtime-subscription';
import {
  RealtimeConnectError,
  type RealtimePresenceSnapshotAck,
  type RealtimeSubscribeAck,
  type ShipRealtimeConnection,
  type ShipRealtimeConnectRequest,
  type ShipRealtimeTransport,
  type ShipRealtimeTransportHandlers,
} from './realtime-transport';

interface TestChannels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly balance: number };
      readonly presence: false;
    };
    readonly 'room.messages': {
      readonly scope: 'resource';
      readonly payload: { readonly text: string };
      readonly presence: true;
    };
  };
}

const MANIFEST: RealtimeManifest<TestChannels> = {
  channels: {
    'account.updated': { scope: 'actor', payload: 'AccountUpdated', presence: false },
    'room.messages': { scope: 'resource', payload: 'RoomMessage', presence: true },
  },
  operations: { 'rooms.post': { publishes: ['room.messages'] } },
};

interface FakeLink extends ShipRealtimeConnection {
  readonly request: ShipRealtimeConnectRequest;
  readonly handlers: ShipRealtimeTransportHandlers;
  readonly subscribed: { channel: string; scopeKey: string }[];
  readonly unsubscribed: string[];
  readonly presenceRequested: { channel: string; scopeKey: string }[];
  closed: boolean;
}

interface Harness {
  readonly transport: ShipRealtimeTransport;
  readonly links: FakeLink[];
  readonly runtime: ShipRealtimeRuntime;
  readonly credentials: string[];
  credential(): string;
  runTimers(): void;
  pendingTimers(): number;
  subscribeAck: (channel: string) => RealtimeSubscribeAck;
  presenceAck: RealtimePresenceSnapshotAck;
  connectError: unknown;
  subscribeRejection: unknown;
  /** Hold every `unsubscribe` ack until {@link Harness.settleUnsubscribes} is called. */
  holdUnsubscribeAck: boolean;
  settleUnsubscribes(): void;
  heldUnsubscribes(): number;
}

function createHarness(): Harness {
  const timers = new Map<number, () => void>();
  const held: (() => void)[] = [];
  let nextTimer = 0;
  let issued = 0;
  const harness: Harness = {
    links: [],
    credentials: [],
    subscribeAck: () => ({ ok: true, subscriptionId: 'subscription-1' }),
    presenceAck: { ok: true, count: 2, members: ['actor-1', 'actor-2'] },
    connectError: undefined,
    subscribeRejection: undefined,
    holdUnsubscribeAck: false,
    heldUnsubscribes: () => held.length,
    settleUnsubscribes: () => {
      const pending = held.splice(0, held.length);
      for (const resolve of pending) resolve();
    },
    credential(): string {
      issued += 1;
      const value = `token-${issued}`;
      harness.credentials.push(value);
      return value;
    },
    runtime: {
      setTimer: (handler: () => void) => {
        nextTimer += 1;
        timers.set(nextTimer, handler);
        return nextTimer;
      },
      clearTimer: (handle: unknown) => {
        timers.delete(handle as number);
      },
      random: () => 0,
    },
    pendingTimers: () => timers.size,
    runTimers: () => {
      const scheduled = [...timers.values()];
      timers.clear();
      for (const handler of scheduled) handler();
    },
    transport: async (request: ShipRealtimeConnectRequest) => {
      if (harness.connectError !== undefined) throw harness.connectError;
      const link: FakeLink = {
        request,
        handlers: request.handlers,
        subscribed: [],
        unsubscribed: [],
        presenceRequested: [],
        closed: false,
        subscribe: async subscription => {
          link.subscribed.push({ ...subscription });
          if (harness.subscribeRejection !== undefined) throw harness.subscribeRejection;
          return harness.subscribeAck(subscription.channel);
        },
        unsubscribe: async subscription => {
          link.unsubscribed.push(subscription.subscriptionId);
          if (harness.holdUnsubscribeAck) {
            await new Promise<void>(resolve => held.push(resolve));
          }
          return { ok: true };
        },
        presenceSnapshot: async subscription => {
          link.presenceRequested.push({ ...subscription });
          return harness.presenceAck;
        },
        close: () => {
          link.closed = true;
        },
      };
      harness.links.push(link);
      return link;
    },
  };
  return harness;
}

function createClient(harness: Harness) {
  return createShipRealtime<TestChannels>(
    {
      url: 'https://gateway.test',
      credential: () => harness.credential(),
      manifest: MANIFEST,
    },
    harness.transport,
    harness.runtime
  );
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function lastLink(harness: Harness): FakeLink {
  const link = harness.links.at(-1);
  if (link === undefined) throw new Error('No transport link was opened');
  return link;
}

describe('createShipRealtime', () => {
  it('opens one link, acknowledges a subscription, and reports it active', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');

    expect(subscription.status()).toBe('pending');
    expect(client.status()).toBe('connecting');
    await flush();

    expect(client.status()).toBe('open');
    expect(subscription.status()).toBe('active');
    expect(subscription.error()).toBeUndefined();
    expect(lastLink(harness).subscribed).toEqual([
      { channel: 'account.updated', scopeKey: 'actor-1' },
    ]);
    expect(harness.credentials).toEqual(['token-1']);
  });

  it('delivers typed payloads to latest and to event handlers', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    const received: RealtimeEvent<{ readonly balance: number }>[] = [];
    const stop = subscription.events(event => received.push(event));
    lastLink(harness).handlers.onEvent({
      channel: 'account.updated',
      scopeKey: 'actor-1',
      seq: 7,
      publishedAt: '2026-09-18T10:00:00.000Z',
      payload: { balance: 10 },
    });

    expect(subscription.latest()).toEqual({ balance: 10 });
    expect(received).toEqual([
      { seq: 7, publishedAt: '2026-09-18T10:00:00.000Z', payload: { balance: 10 } },
    ]);

    stop();
    lastLink(harness).handlers.onEvent({
      channel: 'account.updated',
      scopeKey: 'actor-1',
      seq: 8,
      publishedAt: '2026-09-18T10:00:01.000Z',
      payload: { balance: 20 },
    });
    expect(received).toHaveLength(1);
    expect(subscription.latest()).toEqual({ balance: 20 });
  });

  it('ignores frames addressed to another scope key', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    lastLink(harness).handlers.onEvent({
      channel: 'account.updated',
      scopeKey: 'actor-2',
      seq: 1,
      publishedAt: '2026-09-18T10:00:00.000Z',
      payload: { balance: 99 },
    });

    expect(subscription.latest()).toBeUndefined();
  });

  it.each([
    ['SUBSCRIPTION_FORBIDDEN', 'forbidden'],
    ['INVALID_SCOPE', 'forbidden'],
    ['CHANNEL_NOT_FOUND', 'closed'],
    ['RATE_LIMITED', 'closed'],
  ] as const)('maps the %s ack to the %s subscription state', async (code, expected) => {
    const harness = createHarness();
    harness.subscribeAck = () => ({ ok: false, code, message: 'refused' });
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    expect(subscription.status()).toBe(expected);
    expect(subscription.error()).toBe(code);
    expect(lastLink(harness).closed).toBe(true);
    expect(client.status()).toBe('closed');
  });

  it('never reaches the wire for a channel the manifest does not declare', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = (
      client as unknown as {
        subscribe: (channel: string, scopeKey: string) => ReturnType<typeof client.subscribe>;
      }
    ).subscribe('ghost.channel', 'actor-1');
    await flush();

    expect(subscription.status()).toBe('closed');
    expect(subscription.error()).toBe('CHANNEL_NOT_FOUND');
    expect(harness.links).toHaveLength(0);
    expect(client.status()).toBe('idle');
  });

  it('classifies an unacknowledged subscribe as an ack timeout', async () => {
    const harness = createHarness();
    harness.subscribeRejection = new RealtimeConnectError('no ack', 'TRANSPORT_ERROR');
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    expect(subscription.status()).toBe('closed');
    expect(subscription.error()).toBe('ACK_TIMEOUT');
  });

  it('counts dropped batches per subscription', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    lastLink(harness).handlers.onDropped({
      channel: 'account.updated',
      scopeKey: 'actor-1',
      dropped: 3,
    });
    lastLink(harness).handlers.onDropped({
      channel: 'account.updated',
      scopeKey: 'actor-1',
      dropped: 2,
    });

    expect(subscription.dropped()).toBe(5);
  });

  it('exposes presence only for channels the manifest declares with presence', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const plain = client.subscribe('account.updated', 'actor-1');
    const room = client.subscribe('room.messages', 'room-7');
    await flush();

    expect('presence' in plain).toBe(false);
    expect(room.presence()).toEqual({ count: 2, members: ['actor-1', 'actor-2'] });
    expect(lastLink(harness).presenceRequested).toEqual([
      { channel: 'room.messages', scopeKey: 'room-7' },
    ]);
  });

  it('applies joined and left frames on top of the snapshot', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const room = client.subscribe('room.messages', 'room-7');
    await flush();

    lastLink(harness).handlers.onPresence({
      channel: 'room.messages',
      scopeKey: 'room-7',
      kind: 'joined',
      actorId: 'actor-3',
      count: 3,
    });
    expect(room.presence()).toEqual({ count: 3, members: ['actor-1', 'actor-2', 'actor-3'] });

    lastLink(harness).handlers.onPresence({
      channel: 'room.messages',
      scopeKey: 'room-7',
      kind: 'left',
      actorId: 'actor-1',
      count: 2,
    });
    expect(room.presence()).toEqual({ count: 2, members: ['actor-2', 'actor-3'] });
  });

  it('replays presence frames that raced the snapshot', async () => {
    const harness = createHarness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const baseTransport = harness.transport;
    const client = createShipRealtime<TestChannels>(
      {
        url: 'https://gateway.test',
        credential: () => harness.credential(),
        manifest: MANIFEST,
      },
      async request => {
        const link = await baseTransport(request);
        return {
          ...link,
          presenceSnapshot: async subscription => {
            await gate;
            return link.presenceSnapshot(subscription);
          },
        };
      },
      harness.runtime
    );
    const room = client.subscribe('room.messages', 'room-7');
    await flush();

    lastLink(harness).handlers.onPresence({
      channel: 'room.messages',
      scopeKey: 'room-7',
      kind: 'joined',
      actorId: 'actor-9',
      count: 3,
    });
    expect(room.presence()).toBeUndefined();

    release?.();
    await flush();
    expect(room.presence()).toEqual({ count: 3, members: ['actor-1', 'actor-2', 'actor-9'] });
  });

  it('reconnects after a slow-subscriber disconnect and resubscribes with a fresh credential', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();
    const first = lastLink(harness);

    first.handlers.onDisconnect('ship:slow-subscriber');
    expect(client.status()).toBe('reconnecting');
    expect(subscription.status()).toBe('pending');
    expect(harness.pendingTimers()).toBe(1);

    harness.runTimers();
    await flush();

    expect(harness.links).toHaveLength(2);
    expect(harness.credentials).toEqual(['token-1', 'token-2']);
    expect(lastLink(harness).request.credential).toBe('token-2');
    expect(lastLink(harness).subscribed).toEqual([
      { channel: 'account.updated', scopeKey: 'actor-1' },
    ]);
    expect(subscription.status()).toBe('active');
    expect(client.status()).toBe('open');
  });

  it('resubscribes every live subscription after a reconnect', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    client.subscribe('account.updated', 'actor-1');
    client.subscribe('room.messages', 'room-7');
    await flush();

    lastLink(harness).handlers.onDisconnect('transport close');
    harness.runTimers();
    await flush();

    expect(lastLink(harness).subscribed).toEqual([
      { channel: 'account.updated', scopeKey: 'actor-1' },
      { channel: 'room.messages', scopeKey: 'room-7' },
    ]);
  });

  it('retries a transport-level connect failure with backoff', async () => {
    const harness = createHarness();
    harness.connectError = new RealtimeConnectError('gateway down', 'TRANSPORT_ERROR');
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    expect(client.status()).toBe('reconnecting');
    expect(subscription.status()).toBe('pending');

    harness.connectError = undefined;
    harness.runTimers();
    await flush();

    expect(client.status()).toBe('open');
    expect(subscription.status()).toBe('active');
  });

  it('stops retrying when the gateway refuses authorization', async () => {
    const harness = createHarness();
    harness.connectError = new RealtimeConnectError('not allowed', 'AUTHORIZATION_ERROR');
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    expect(client.status()).toBe('error');
    expect(subscription.status()).toBe('forbidden');
    expect(subscription.error()).toBe('CONNECTION_REFUSED');
    expect(harness.pendingTimers()).toBe(0);
  });

  it('stops delivery, releases the link, and tells the gateway on unsubscribe', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();
    const link = lastLink(harness);

    const received: number[] = [];
    subscription.events(event => received.push(event.seq));
    subscription.unsubscribe();
    await flush();

    expect(link.unsubscribed).toEqual(['subscription-1']);
    expect(subscription.status()).toBe('closed');
    expect(link.closed).toBe(true);
    expect(client.status()).toBe('closed');

    link.handlers.onEvent({
      channel: 'account.updated',
      scopeKey: 'actor-1',
      seq: 1,
      publishedAt: '2026-09-18T10:00:00.000Z',
      payload: { balance: 1 },
    });
    expect(received).toEqual([]);
    expect(subscription.latest()).toBeUndefined();
  });

  it('waits for the final unsubscribe ack before it closes the idle link', async () => {
    const harness = createHarness();
    harness.holdUnsubscribeAck = true;
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();
    const link = lastLink(harness);

    subscription.unsubscribe();
    await flush();

    expect(link.unsubscribed).toEqual(['subscription-1']);
    expect(subscription.status()).toBe('closed');
    expect(link.closed).toBe(false);
    expect(client.status()).toBe('open');

    harness.settleUnsubscribes();
    await flush();

    expect(link.closed).toBe(true);
    expect(client.status()).toBe('closed');
    expect(harness.pendingTimers()).toBe(0);
  });

  it('closes the idle link anyway when the final unsubscribe ack times out', async () => {
    const harness = createHarness();
    harness.holdUnsubscribeAck = true;
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();
    const link = lastLink(harness);

    subscription.unsubscribe();
    await flush();
    expect(link.closed).toBe(false);
    expect(harness.pendingTimers()).toBe(1);

    harness.runTimers();
    await flush();

    expect(link.closed).toBe(true);
    expect(client.status()).toBe('closed');
    expect(harness.pendingTimers()).toBe(0);
  });

  it('closes immediately when close() lands while the final ack is still pending', async () => {
    const harness = createHarness();
    harness.holdUnsubscribeAck = true;
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();
    const link = lastLink(harness);

    subscription.unsubscribe();
    await flush();
    expect(link.closed).toBe(false);
    expect(harness.heldUnsubscribes()).toBe(1);

    client.close();

    expect(link.closed).toBe(true);
    expect(client.status()).toBe('closed');
    expect(harness.pendingTimers()).toBe(0);

    // A late ack must not reopen anything or reach a destroyed client.
    harness.settleUnsubscribes();
    await flush();
    expect(harness.links).toHaveLength(1);
    expect(client.status()).toBe('closed');
  });

  it('keeps the link open when the unsubscribed subscription was not the last one', async () => {
    const harness = createHarness();
    harness.holdUnsubscribeAck = true;
    harness.subscribeAck = channel => ({
      ok: true,
      subscriptionId: channel === 'room.messages' ? 'subscription-room' : 'subscription-account',
    });
    const client = createClient(harness);
    const account = client.subscribe('account.updated', 'actor-1');
    client.subscribe('room.messages', 'room-7');
    await flush();
    const link = lastLink(harness);

    account.unsubscribe();
    await flush();

    expect(link.unsubscribed).toEqual(['subscription-account']);
    expect(link.closed).toBe(false);
    expect(client.status()).toBe('open');
    expect(harness.pendingTimers()).toBe(0);
  });

  it('closes every subscription and the link on close()', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    const subscription = client.subscribe('account.updated', 'actor-1');
    await flush();

    client.close();
    client.close();

    expect(subscription.status()).toBe('closed');
    expect(lastLink(harness).closed).toBe(true);
    expect(client.status()).toBe('closed');

    const afterClose = client.subscribe('account.updated', 'actor-1');
    await flush();
    expect(afterClose.status()).toBe('closed');
    expect(harness.links).toHaveLength(1);
  });

  it('reuses an open link for a later subscription', async () => {
    const harness = createHarness();
    const client = createClient(harness);
    client.subscribe('account.updated', 'actor-1');
    await flush();
    client.subscribe('room.messages', 'room-7');
    await flush();

    expect(harness.links).toHaveLength(1);
    expect(lastLink(harness).subscribed).toHaveLength(2);
  });
});

describe('indexRealtimeChannels', () => {
  it('accepts the declared projection and exposes publishes', () => {
    expect([...indexRealtimeChannels(MANIFEST).keys()]).toEqual([
      'account.updated',
      'room.messages',
    ]);
    expect(channelsPublishedBy(MANIFEST, 'rooms.post')).toEqual(['room.messages']);
    expect(channelsPublishedBy(MANIFEST, 'rooms.absent')).toEqual([]);
  });

  it('reads publishes from the array form the client manifest already uses', () => {
    const arrayManifest = {
      channels: MANIFEST.channels,
      operations: [{ id: 'rooms.post', publishes: ['room.messages'] }],
    } as const;
    expect(channelsPublishedBy(arrayManifest, 'rooms.post')).toEqual(['room.messages']);
    expect(channelsPublishedBy(arrayManifest, 'rooms.absent')).toEqual([]);
    expect([...indexRealtimeChannels(arrayManifest).keys()]).toHaveLength(2);
    expect(() =>
      indexRealtimeChannels({
        channels: MANIFEST.channels,
        operations: [{ id: 'rooms.post', publishes: ['missing'] }],
      })
    ).toThrowError(/undeclared channel missing/);
  });

  it.each([
    [{}, 'does not declare a channels map'],
    [{ channels: { bad: { scope: 'global', payload: 'X', presence: false } } }, 'invalid channel'],
    [{ channels: { bad: { scope: 'actor', payload: 1, presence: false } } }, 'invalid channel'],
    [{ channels: { bad: { scope: 'actor', payload: 'X' } } }, 'invalid channel'],
    [
      {
        channels: { ok: { scope: 'actor', payload: 'X', presence: false } },
        operations: { 'a.b': { publishes: ['missing'] } },
      },
      'undeclared channel missing',
    ],
  ])('rejects an invalid manifest (%#)', (manifest, message) => {
    expect(() => indexRealtimeChannels(manifest as never)).toThrowError(
      new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });
});
