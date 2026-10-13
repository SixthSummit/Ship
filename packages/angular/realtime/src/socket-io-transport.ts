import {
  RealtimeConnectError,
  type RealtimeConnectErrorCode,
  type RealtimeDroppedFrame,
  type RealtimeEventFrame,
  type RealtimePresenceFrame,
  type RealtimePresenceSnapshotAck,
  type RealtimePresenceSnapshotErrorCode,
  type RealtimeSubscribeAck,
  type RealtimeSubscribeErrorCode,
  type RealtimeUnsubscribeAck,
  type ShipRealtimeConnection,
  type ShipRealtimeConnectRequest,
  type ShipRealtimeTransport,
} from './realtime-transport';

/**
 * Structural view of the one `socket.io-client` surface this adapter uses.
 *
 * Declared locally so the published types never depend on `socket.io-client`, which is
 * an optional peer: applications that do not use `./realtime` must not need it.
 */
interface SocketIoLike {
  on(event: string, handler: (...args: never[]) => void): unknown;
  timeout(ms: number): { emit(event: string, payload: unknown, ack: AckCallback): unknown };
  disconnect(): unknown;
}

type AckCallback = (error: unknown, response?: unknown) => void;

interface SocketIoFactory {
  (uri: string, options: Readonly<Record<string, unknown>>): SocketIoLike;
}

/** How the adapter obtains `socket.io-client`. Overridden only by the unit suite. */
export type SocketIoLoader = () => Promise<SocketIoFactory>;

/** Namespace fixed by the wire protocol. */
const NAMESPACE = '/ship';

const CONNECT_ERROR_CODES: ReadonlySet<string> = new Set<RealtimeConnectErrorCode>([
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'AUTHENTICATION_UNAVAILABLE',
]);

const loadSocketIo: SocketIoLoader = async () => {
  const module = await import('socket.io-client');
  return module.io as unknown as SocketIoFactory;
};

/**
 * Socket.IO implementation of the realtime transport boundary.
 *
 * Socket.IO's own reconnection is disabled: reconnect, backoff, credential refresh and
 * resubscribe-all belong to the client so every transport behaves identically.
 */
export function createSocketIoTransport(
  load: SocketIoLoader = loadSocketIo
): ShipRealtimeTransport {
  return async (request: ShipRealtimeConnectRequest): Promise<ShipRealtimeConnection> => {
    const io = await load();
    const socket = io(namespaceUrl(request.url), {
      auth: { credential: request.credential },
      reconnection: false,
      forceNew: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('ship:event', ((frame: unknown) => {
      const event = asEventFrame(frame);
      if (event !== undefined) request.handlers.onEvent(event);
    }) as (...args: never[]) => void);
    socket.on('ship:presence', ((frame: unknown) => {
      const presence = asPresenceFrame(frame);
      if (presence !== undefined) request.handlers.onPresence(presence);
    }) as (...args: never[]) => void);
    socket.on('ship:dropped', ((frame: unknown) => {
      const dropped = asDroppedFrame(frame);
      if (dropped !== undefined) request.handlers.onDropped(dropped);
    }) as (...args: never[]) => void);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.on('connect', (() => {
        if (settled) return;
        settled = true;
        resolve();
      }) as (...args: never[]) => void);
      socket.on('connect_error', ((error: unknown) => {
        if (settled) return;
        settled = true;
        socket.disconnect();
        reject(toConnectError(error));
      }) as (...args: never[]) => void);
    });

    socket.on('disconnect', ((reason: unknown) => {
      request.handlers.onDisconnect(typeof reason === 'string' ? reason : 'transport error');
    }) as (...args: never[]) => void);

    const call = <TAck>(event: string, payload: unknown, decode: (value: unknown) => TAck) =>
      new Promise<TAck>((resolve, reject) => {
        socket.timeout(request.ackTimeoutMs).emit(event, payload, (error, response) => {
          if (error !== null && error !== undefined) {
            reject(new RealtimeConnectError(`${event} was not acknowledged`, 'TRANSPORT_ERROR'));
            return;
          }
          try {
            resolve(decode(response));
          } catch (failure: unknown) {
            reject(failure);
          }
        });
      });

    return {
      subscribe: subscription => call('ship:subscribe', subscription, decodeSubscribeAck),
      unsubscribe: subscription => call('ship:unsubscribe', subscription, decodeUnsubscribeAck),
      presenceSnapshot: subscription =>
        call('ship:presence.snapshot', subscription, decodePresenceAck),
      close: () => {
        socket.disconnect();
      },
    };
  };
}

function namespaceUrl(url: string): string {
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  return `${trimmed}${NAMESPACE}`;
}

function toConnectError(error: unknown): RealtimeConnectError {
  const data = isRecord(error) ? error['data'] : undefined;
  const code = isRecord(data) ? data['code'] : undefined;
  const message =
    isRecord(data) && typeof data['message'] === 'string' ? data['message'] : undefined;
  if (typeof code === 'string' && CONNECT_ERROR_CODES.has(code)) {
    return new RealtimeConnectError(
      message ?? 'The realtime gateway refused the connection',
      code as RealtimeConnectErrorCode
    );
  }
  return new RealtimeConnectError(
    message ?? errorMessage(error) ?? 'The realtime transport failed',
    'TRANSPORT_ERROR'
  );
}

function decodeSubscribeAck(value: unknown): RealtimeSubscribeAck {
  if (!isRecord(value)) throw new RealtimeConnectError('Invalid subscribe ack', 'TRANSPORT_ERROR');
  if (value['ok'] === true && typeof value['subscriptionId'] === 'string') {
    return { ok: true, subscriptionId: value['subscriptionId'] };
  }
  if (value['ok'] === false && typeof value['code'] === 'string') {
    return {
      ok: false,
      code: value['code'] as RealtimeSubscribeErrorCode,
      message: typeof value['message'] === 'string' ? value['message'] : '',
    };
  }
  throw new RealtimeConnectError('Invalid subscribe ack', 'TRANSPORT_ERROR');
}

function decodeUnsubscribeAck(value: unknown): RealtimeUnsubscribeAck {
  if (isRecord(value) && value['ok'] === true) return { ok: true };
  if (isRecord(value) && value['ok'] === false && value['code'] === 'UNKNOWN_SUBSCRIPTION') {
    return {
      ok: false,
      code: 'UNKNOWN_SUBSCRIPTION',
      message: typeof value['message'] === 'string' ? value['message'] : '',
    };
  }
  throw new RealtimeConnectError('Invalid unsubscribe ack', 'TRANSPORT_ERROR');
}

function decodePresenceAck(value: unknown): RealtimePresenceSnapshotAck {
  if (!isRecord(value)) throw new RealtimeConnectError('Invalid presence ack', 'TRANSPORT_ERROR');
  if (
    value['ok'] === true &&
    typeof value['count'] === 'number' &&
    Array.isArray(value['members'])
  ) {
    return {
      ok: true,
      count: value['count'],
      members: value['members'].filter((member): member is string => typeof member === 'string'),
    };
  }
  if (value['ok'] === false && typeof value['code'] === 'string') {
    return {
      ok: false,
      code: value['code'] as RealtimePresenceSnapshotErrorCode,
      message: typeof value['message'] === 'string' ? value['message'] : '',
    };
  }
  throw new RealtimeConnectError('Invalid presence ack', 'TRANSPORT_ERROR');
}

function asEventFrame(value: unknown): RealtimeEventFrame | undefined {
  if (
    !isRecord(value) ||
    typeof value['channel'] !== 'string' ||
    typeof value['scopeKey'] !== 'string' ||
    typeof value['seq'] !== 'number' ||
    typeof value['publishedAt'] !== 'string'
  ) {
    return undefined;
  }
  return {
    channel: value['channel'],
    scopeKey: value['scopeKey'],
    seq: value['seq'],
    publishedAt: value['publishedAt'],
    payload: value['payload'],
  };
}

function asPresenceFrame(value: unknown): RealtimePresenceFrame | undefined {
  if (
    !isRecord(value) ||
    typeof value['channel'] !== 'string' ||
    typeof value['scopeKey'] !== 'string' ||
    (value['kind'] !== 'joined' && value['kind'] !== 'left') ||
    typeof value['actorId'] !== 'string' ||
    typeof value['count'] !== 'number'
  ) {
    return undefined;
  }
  return {
    channel: value['channel'],
    scopeKey: value['scopeKey'],
    kind: value['kind'],
    actorId: value['actorId'],
    count: value['count'],
  };
}

function asDroppedFrame(value: unknown): RealtimeDroppedFrame | undefined {
  if (
    !isRecord(value) ||
    typeof value['channel'] !== 'string' ||
    typeof value['scopeKey'] !== 'string' ||
    typeof value['dropped'] !== 'number'
  ) {
    return undefined;
  }
  return {
    channel: value['channel'],
    scopeKey: value['scopeKey'],
    dropped: value['dropped'],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value['message'] === 'string' ? value['message'] : undefined;
}
