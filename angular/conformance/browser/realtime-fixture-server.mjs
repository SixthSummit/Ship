import { createServer } from 'node:http';
import { Server } from 'socket.io';

/**
 * Deterministic Socket.IO gateway implementing the ShipAngular realtime wire protocol
 * verbatim: the `/ship` namespace, `auth.credential`, the three client events with acks,
 * and the `ship:event` / `ship:presence` / `ship:dropped` server events.
 */
export async function createRealtimeFixtureServer() {
  let allowedOrigin;
  const metrics = {
    connections: [],
    rejections: [],
    subscribes: [],
    unsubscribes: [],
    presenceSnapshots: [],
  };

  const httpServer = createServer((request, response) => {
    const url = new globalThis.URL(request.url ?? '/', 'http://realtime-fixture.invalid');
    if (allowedOrigin !== undefined && request.headers.origin === allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    response.setHeader('Vary', 'Origin');
    if (url.pathname === '/realtime-metrics') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(metrics));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, origin === allowedOrigin),
      credentials: true,
    },
  });
  const ship = io.of('/ship');

  ship.use((socket, next) => {
    const credential = socket.handshake.auth?.credential;
    if (typeof credential !== 'string' || !credential.startsWith('browser-realtime-token-')) {
      metrics.rejections.push({ credential: credential ?? null });
      const error = new Error('The realtime credential was rejected');
      error.data = {
        code: 'AUTHENTICATION_ERROR',
        message: 'The realtime credential was rejected',
      };
      next(error);
      return;
    }
    socket.data.actorId = 'actor-conformance';
    socket.data.credential = credential;
    next();
  });

  ship.on('connection', socket => {
    const connection = metrics.connections.length + 1;
    metrics.connections.push({
      connection,
      credential: socket.data.credential,
      origin: socket.handshake.headers.origin,
    });
    let nextSubscription = 0;
    let nextSeq = 0;

    socket.on('ship:subscribe', (request, ack) => {
      metrics.subscribes.push({ connection, ...request });
      const declaration = CHANNELS[request?.channel];
      if (declaration === undefined) {
        ack({ ok: false, code: 'CHANNEL_NOT_FOUND', message: 'No such channel' });
        return;
      }
      if (declaration.scope === 'actor' && request.scopeKey !== socket.data.actorId) {
        ack({ ok: false, code: 'INVALID_SCOPE', message: 'Actor channels are self-scoped' });
        return;
      }
      if (declaration.scope === 'tenant') {
        ack({
          ok: false,
          code: 'SUBSCRIPTION_FORBIDDEN',
          message: 'The actor is not a member of that tenant',
        });
        return;
      }
      nextSubscription += 1;
      const subscriptionId = `subscription-${connection}-${nextSubscription}`;
      ack({ ok: true, subscriptionId });

      // Everything below proves the server->client half of the protocol.
      setTimeout(() => {
        if (socket.disconnected) return;
        socket.emit('ship:presence', {
          channel: request.channel,
          scopeKey: request.scopeKey,
          kind: 'joined',
          actorId: 'actor-observer',
          count: 2,
        });
        nextSeq += 1;
        socket.emit('ship:event', {
          channel: request.channel,
          scopeKey: request.scopeKey,
          seq: nextSeq,
          publishedAt: new Date(0).toISOString(),
          payload: { roomId: request.scopeKey, text: `hello from ${request.channel}` },
        });
        socket.emit('ship:dropped', {
          channel: request.channel,
          scopeKey: request.scopeKey,
          dropped: 3,
        });
      }, 10);
    });

    socket.on('ship:unsubscribe', (request, ack) => {
      metrics.unsubscribes.push({ connection, ...request });
      if (typeof request?.subscriptionId !== 'string') {
        ack({ ok: false, code: 'UNKNOWN_SUBSCRIPTION', message: 'Unknown subscription' });
        return;
      }
      ack({ ok: true });
    });

    socket.on('ship:presence.snapshot', (request, ack) => {
      metrics.presenceSnapshots.push({ connection, ...request });
      const declaration = CHANNELS[request?.channel];
      if (declaration === undefined) {
        ack({ ok: false, code: 'CHANNEL_NOT_FOUND', message: 'No such channel' });
        return;
      }
      if (!declaration.presence) {
        ack({ ok: false, code: 'PRESENCE_DISABLED', message: 'Presence is not tracked' });
        return;
      }
      ack({ ok: true, count: 1, members: ['actor-conformance'] });
    });

    socket.on('ship:slow-subscriber.simulate', () => {
      socket.disconnect(true);
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Realtime fixture server has no port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    setAllowedOrigin(value) {
      allowedOrigin = value;
    },
    snapshot: () => globalThis.structuredClone(metrics),
    close: async () => {
      await io.close();
      await new Promise(resolve => httpServer.close(() => resolve()));
    },
  };
}

/** The realtime projection the synthetic ShipAPI fixture manifest declares. */
const CHANNELS = {
  'account.updated': { scope: 'actor', presence: false },
  'room.messages': { scope: 'resource', presence: true },
  'tenant.audit': { scope: 'tenant', presence: false },
};
