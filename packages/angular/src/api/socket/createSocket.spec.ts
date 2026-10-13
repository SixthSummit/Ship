import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocket } from './createSocket';

/**
 * Mock WebSocket implementation. Tracks the last instance globally for
 * specs to drive lifecycle events (`open`, `message`, `error`, `close`).
 */
class MockSocket {
  static instances: MockSocket[] = [];
  static OPEN = 1 as const;

  readyState = 0; // CONNECTING
  url: string;
  subprotocols: readonly string[];
  sent: unknown[] = [];

  // WebSocket-style readonly statics referenced by createSocket via the
  // injected WS option.
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSING = 2 as const;
  CLOSED = 3 as const;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.subprotocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    MockSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    queueMicrotask(() => {
      this.onclose?.({ code: code ?? 1000, reason: reason ?? '' } as CloseEvent);
    });
  }

  // Test helpers
  emitOpen() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  emitMessage(data: unknown) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: payload } as MessageEvent);
  }
  emitError() {
    this.onerror?.({} as Event);
  }
  emitClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }
}

const lastSocket = (): MockSocket => MockSocket.instances[MockSocket.instances.length - 1];

beforeEach(() => {
  MockSocket.instances = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSocket — lifecycle', () => {
  it('opens with default subprotocol ship-api.v1 and transitions through connecting → open', () => {
    const s = createSocket<{ x: number }>('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    expect(s.status()).toBe('connecting');
    expect(lastSocket().subprotocols).toEqual(['ship-api.v1']);
    lastSocket().emitOpen();
    expect(s.status()).toBe('open');
  });

  it('passes a custom subprotocol list (function form)', () => {
    createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      subprotocols: () => ['ship-api.v1', 'bearer.tok'],
      reconnect: false,
    });
    expect(lastSocket().subprotocols).toEqual(['ship-api.v1', 'bearer.tok']);
  });

  it('decodes JSON server frames into messages', () => {
    const s = createSocket<{ x: number }>('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    lastSocket().emitMessage({ x: 1 });
    lastSocket().emitMessage({ x: 2 });
    expect(s.messages()).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('uses a custom decoder', () => {
    const s = createSocket<string>('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
      decode: e => (typeof e.data === 'string' ? `RX:${e.data}` : undefined),
    });
    lastSocket().emitOpen();
    lastSocket().onmessage?.({ data: 'hi' } as MessageEvent);
    expect(s.messages()).toEqual(['RX:hi']);
  });

  it('send() encodes via JSON.stringify by default', () => {
    const s = createSocket<unknown, { y: number }>('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    s.send({ y: 7 });
    expect(lastSocket().sent[0]).toBe(JSON.stringify({ y: 7 }));
  });

  it('send() drops silently when not open', () => {
    const s = createSocket<unknown, { y: number }>('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    // Not open yet.
    s.send({ y: 7 });
    expect(lastSocket().sent).toHaveLength(0);
  });

  it('close() transitions through closing → closed (clean)', async () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    s.close();
    expect(s.status()).toBe('closing');
    // The mock's close schedules onclose via microtask
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(s.status()).toBe('closed');
  });
});

describe('createSocket — reconnect', () => {
  it('schedules a reconnect on unexpected close', () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnectMinMs: 100,
      reconnectMaxMs: 1000,
    });
    lastSocket().emitOpen();
    expect(s.status()).toBe('open');
    lastSocket().emitClose(1006);
    expect(s.status()).toBe('reconnecting');
    expect(MockSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000); // > maxMs * 2
    expect(MockSocket.instances).toHaveLength(2);
  });

  it('does NOT reconnect on clean close (1000)', () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnectMinMs: 100,
    });
    lastSocket().emitOpen();
    lastSocket().emitClose(1000);
    expect(s.status()).toBe('closed');
    vi.advanceTimersByTime(5000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('reconnect: false disables auto-reconnect on unexpected close', () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    lastSocket().emitClose(1006);
    expect(s.status()).toBe('closed');
    vi.advanceTimersByTime(60000);
    expect(MockSocket.instances).toHaveLength(1);
  });

  it('honours reconnectMaxAttempts and stops retrying', () => {
    createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnectMinMs: 1,
      reconnectMaxMs: 1,
      reconnectMaxAttempts: 2,
    });
    // Initial attempt
    lastSocket().emitClose(1006);
    vi.advanceTimersByTime(10);
    // 2nd attempt
    lastSocket().emitClose(1006);
    vi.advanceTimersByTime(10);
    // 3rd attempt
    lastSocket().emitClose(1006);
    vi.advanceTimersByTime(10);
    // No further attempts
    expect(MockSocket.instances).toHaveLength(3);
  });

  it('reconnect() manually triggers a fresh connect', () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    lastSocket().emitClose(1006);
    expect(s.status()).toBe('closed');
    s.reconnect();
    expect(MockSocket.instances).toHaveLength(2);
    expect(s.status()).toBe('connecting');
  });

  it('reconnect() is no-op when already open', () => {
    const s = createSocket('ws://test/x', {
      WebSocket: MockSocket as unknown as typeof WebSocket,
      reconnect: false,
    });
    lastSocket().emitOpen();
    s.reconnect();
    expect(MockSocket.instances).toHaveLength(1);
  });
});

describe('createSocket — SSR safety', () => {
  it('stays idle when WebSocket is unavailable on globalThis', () => {
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    try {
      const s = createSocket('ws://test/x', { reconnect: false });
      expect(s.status()).toBe('idle');
      expect(MockSocket.instances).toHaveLength(0);
    } finally {
      if (original) {
        (globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original;
      }
    }
  });
});
