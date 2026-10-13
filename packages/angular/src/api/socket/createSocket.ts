import { type Signal, signal, type WritableSignal } from '@angular/core';

/**
 * Status of a {@link ShipSocket}.
 *
 * Mirrors the WebSocket readyState values, plus an `'error'` terminal
 * state and a pre-connect `'idle'` for the brief moment before the first
 * connect attempt.
 *
 * - `'idle'` — never connected
 * - `'connecting'` — connect in flight
 * - `'open'` — connected, frames flowing
 * - `'closing'` — close handshake initiated
 * - `'closed'` — disconnected (clean or unclean)
 * - `'error'` — connect failed or fatal protocol error
 * - `'reconnecting'` — between attempts during exponential backoff
 */
export type ShipSocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'error'
  | 'reconnecting';

/**
 * Reactive WebSocket primitive returned by {@link createSocket}.
 */
export interface ShipSocket<TServer, TClient = TServer> {
  /**
   * All messages received so far, in arrival order. Updates after each
   * decoded server frame.
   */
  readonly messages: Signal<readonly TServer[]>;
  /** Current connection status. */
  readonly status: Signal<ShipSocketStatus>;
  /** The most recent error, or `undefined`. */
  readonly error: Signal<unknown>;
  /** Send a typed message to the server. Drops silently when not open. */
  send(msg: TClient): void;
  /** Initiate a graceful close. The socket transitions through `'closing'` then `'closed'`. */
  close(code?: number, reason?: string): void;
  /**
   * Manually trigger a reconnect attempt. No-op when already connecting /
   * open. Useful for "online again" UX after `OnlineService` reports a
   * transition.
   */
  reconnect(): void;
}

export interface CreateSocketOptions<TServer = unknown, TClient = TServer> {
  /**
   * Subprotocols passed to the WebSocket constructor. Default:
   * `['ship-api.v1']`. To carry an auth token via subprotocol-bearer
   * (matches ShipAPI's `authenticateWsUpgrade`), provide
   * `['ship-api.v1', `bearer.${token}`]` — typically computed via
   * `subprotocols: () => [...]` for reactive token reads.
   *
   * Accepts a function so the value can be reactive: signal reads inside
   * the factory cause subsequent reconnects to rebuild the subprotocol
   * list (e.g., picking up a fresh idToken after a refresh).
   */
  subprotocols?: readonly string[] | (() => readonly string[]);
  /**
   * Decode an incoming WebSocket message into the typed message shape.
   * Default: `JSON.parse(event.data)` for string frames, `event.data`
   * unchanged for binary.
   */
  decode?: (event: MessageEvent) => TServer | undefined;
  /**
   * Encode an outgoing typed message into the wire payload. Default:
   * `JSON.stringify(msg)`.
   */
  encode?: (msg: TClient) => string | ArrayBuffer | Blob | ArrayBufferView;
  /**
   * Auto-reconnect on unexpected close. Default: `true`. Reconnect
   * uses exponential backoff with jitter starting at `reconnectMinMs`,
   * doubling up to `reconnectMaxMs`.
   */
  reconnect?: boolean;
  /** Lower bound on reconnect delay. Default: `500ms`. */
  reconnectMinMs?: number;
  /** Upper bound on reconnect delay. Default: `30000ms` (30s). */
  reconnectMaxMs?: number;
  /**
   * Maximum number of reconnect attempts. After this many consecutive
   * failures, the socket transitions to `'closed'` and stops retrying.
   * `Infinity` to retry forever. Default: `Infinity`.
   */
  reconnectMaxAttempts?: number;
  /**
   * WebSocket constructor override (testing / non-browser environments).
   * Default: `globalThis.WebSocket`.
   */
  WebSocket?: typeof WebSocket;
}

const defaultDecode = <TServer>(event: MessageEvent): TServer | undefined => {
  if (typeof event.data === 'string') {
    try {
      return JSON.parse(event.data) as TServer;
    } catch {
      return undefined;
    }
  }
  return event.data as TServer;
};

const defaultEncode = (msg: unknown): string => JSON.stringify(msg);

/**
 * Reactive WebSocket primitive aligned with ShipAPI v4's
 * `authenticateWsUpgrade` subprotocol-bearer auth pattern.
 *
 * Auto-reconnect with exponential-backoff + jitter. Token re-read on
 * each reconnect attempt (via the function form of `subprotocols`).
 * SSR-safe: when `WebSocket` is undefined (server context), the socket
 * stays in `'idle'` and `messages` / `status` are inert.
 *
 * @example Subscribe to ShipAPI notifications
 * ```ts
 * import { createSocket, AuthService } from '@sixthsummit/ship-angular';
 *
 * @Injectable({ providedIn: 'root' })
 * export class NotificationsService {
 *   private auth = inject(AuthService);
 *   readonly socket = createSocket<NotificationEvent>(
 *     () => `${env.wsBase}/ws/notifications`,
 *     {
 *       subprotocols: () => {
 *         const token = this.auth.idToken();
 *         return token ? ['ship-api.v1', `bearer.${token}`] : ['ship-api.v1'];
 *       },
 *     }
 *   );
 * }
 * ```
 */
export function createSocket<TServer = unknown, TClient = TServer>(
  url: string | (() => string),
  options: CreateSocketOptions<TServer, TClient> = {}
): ShipSocket<TServer, TClient> {
  const messages = signal<readonly TServer[]>([]);
  const status: WritableSignal<ShipSocketStatus> = signal('idle');
  const error = signal<unknown>(undefined);
  const decode = options.decode ?? (defaultDecode as (e: MessageEvent) => TServer | undefined);
  const encode =
    (options.encode as
      | ((m: TClient) => string | ArrayBuffer | Blob | ArrayBufferView)
      | undefined) ?? (defaultEncode as (m: TClient) => string);
  const WS = options.WebSocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  const reconnectEnabled = options.reconnect !== false;
  const minMs = options.reconnectMinMs ?? 500;
  const maxMs = options.reconnectMaxMs ?? 30000;
  // `maxAttempts` is the number of RETRY attempts (not counting the initial
  // connect). `Infinity` retries forever. After the cap is exceeded, status
  // settles on `'closed'`.
  const maxAttempts = options.reconnectMaxAttempts ?? Infinity;

  let socket: WebSocket | undefined;
  let attempts = 0;
  let manualClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const resolveSubprotocols = (): readonly string[] => {
    if (!options.subprotocols) return ['ship-api.v1'];
    return typeof options.subprotocols === 'function'
      ? options.subprotocols()
      : options.subprotocols;
  };

  const resolveUrl = (): string => (typeof url === 'function' ? url() : url);

  const cleanup = () => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const scheduleReconnect = () => {
    if (!reconnectEnabled || manualClose || attempts > maxAttempts) {
      status.set('closed');
      return;
    }
    status.set('reconnecting');
    const exponent = Math.min(attempts, 10);
    const base = Math.min(minMs * 2 ** exponent, maxMs);
    const jitter = Math.floor(Math.random() * (base / 2));
    const delay = base + jitter;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (!WS) {
      // SSR / non-browser environment — stay idle.
      return;
    }
    cleanup();
    manualClose = false;
    status.set(attempts === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WS(resolveUrl(), [...resolveSubprotocols()]);
    } catch (e) {
      error.set(e);
      status.set('error');
      attempts++;
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      status.set('open');
    };
    ws.onmessage = event => {
      const decoded = decode(event);
      if (decoded !== undefined) {
        messages.update(prev => [...prev, decoded]);
      }
    };
    ws.onerror = e => {
      error.set(e);
      // 'error' is non-terminal in the WebSocket lifecycle — onclose
      // follows. Don't transition status from here.
    };
    ws.onclose = e => {
      socket = undefined;
      if (manualClose || e.code === 1000 || e.code === 1001) {
        // Clean close — stop here.
        status.set('closed');
        return;
      }
      attempts++;
      scheduleReconnect();
    };
  };

  const send = (msg: TClient) => {
    if (!socket || socket.readyState !== WS?.OPEN) return;
    socket.send(encode(msg) as string);
  };

  const close = (code?: number, reason?: string) => {
    manualClose = true;
    cleanup();
    if (!socket) {
      status.set('closed');
      return;
    }
    status.set('closing');
    try {
      socket.close(code, reason);
    } catch {
      socket = undefined;
      status.set('closed');
    }
  };

  const reconnect = () => {
    if (status() === 'open' || status() === 'connecting') return;
    cleanup();
    attempts = 0;
    connect();
  };

  // Kick off the initial connect.
  connect();

  return {
    messages: messages.asReadonly(),
    status: status.asReadonly(),
    error: error.asReadonly(),
    send,
    close,
    reconnect,
  };
}
