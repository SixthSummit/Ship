import { EventEmitter } from "node:events";
import { Redis, type RedisOptions } from "ioredis";

/**
 * The narrow Redis surface the adapter needs. Keeping it explicit lets unit
 * tests run against an in-process implementation and keeps the production
 * client swappable.
 */
export interface RealtimeRedis {
  readonly kind: "ship.realtime-redis";
  publish(channel: string, message: string): Promise<void>;
  /** Registers a handler on a dedicated subscriber connection. */
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, ...fields: readonly string[]): Promise<void>;
  hgetall(key: string): Promise<Readonly<Record<string, string>>>;
  sadd(key: string, ...members: readonly string[]): Promise<void>;
  srem(key: string, ...members: readonly string[]): Promise<void>;
  smembers(key: string): Promise<readonly string[]>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  exists(key: string): Promise<boolean>;
  del(...keys: readonly string[]): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface IoredisTransportOptions {
  readonly url?: string;
  readonly options?: RedisOptions;
  /** Existing clients; the adapter never closes clients it did not create. */
  readonly clients?: { readonly commands: Redis; readonly subscriber: Redis };
}

/** Wraps two ioredis connections (commands + pub/sub subscriber). */
export function createIoredisTransport(options: IoredisTransportOptions = {}): RealtimeRedis {
  const owned = options.clients === undefined;
  const create = (): Redis =>
    options.url
      ? new Redis(options.url, { lazyConnect: false, maxRetriesPerRequest: 3, ...options.options })
      : new Redis({ lazyConnect: false, maxRetriesPerRequest: 3, ...options.options });
  const commands = options.clients?.commands ?? create();
  const subscriber = options.clients?.subscriber ?? create();
  const handlers = new Map<string, (message: string) => void>();
  subscriber.on("message", (channel: string, message: string) => handlers.get(channel)?.(message));

  const transport: RealtimeRedis = {
    kind: "ship.realtime-redis",
    publish: async (channel, message) => {
      await commands.publish(channel, message);
    },
    subscribe: async (channel, handler) => {
      handlers.set(channel, handler);
      await subscriber.subscribe(channel);
    },
    unsubscribe: async (channel) => {
      handlers.delete(channel);
      await subscriber.unsubscribe(channel);
    },
    hset: async (key, field, value) => {
      await commands.hset(key, field, value);
    },
    hdel: async (key, ...fields) => {
      if (fields.length > 0) await commands.hdel(key, ...fields);
    },
    hgetall: (key) => commands.hgetall(key),
    sadd: async (key, ...members) => {
      if (members.length > 0) await commands.sadd(key, ...members);
    },
    srem: async (key, ...members) => {
      if (members.length > 0) await commands.srem(key, ...members);
    },
    smembers: (key) => commands.smembers(key),
    set: async (key, value, ttlMs) => {
      if (ttlMs === undefined) await commands.set(key, value);
      else await commands.set(key, value, "PX", ttlMs);
    },
    exists: async (key) => (await commands.exists(key)) > 0,
    del: async (...keys) => {
      if (keys.length > 0) await commands.del(...keys);
    },
    ping: async () => {
      if (commands.status !== "ready" || subscriber.status !== "ready") {
        throw new Error("Realtime Redis command or pub/sub connection is not ready");
      }
      await Promise.all([commands.ping(), subscriber.ping()]);
    },
    close: async () => {
      if (!owned) return;
      await Promise.all([commands.quit(), subscriber.quit()]).catch(() => undefined);
    },
  };
  return Object.freeze(transport);
}

/**
 * In-process Redis stand-in for unit tests. Pub/sub is synchronous-ish
 * (delivered on the next microtask), TTLs expire on read, and multiple
 * transports created from one `createMemoryRedisHub()` share state so a
 * publisher and several gateways can be exercised in one process.
 */
export interface MemoryRedisHub {
  transport(): RealtimeRedis;
  /** Snapshot of every stored key for assertions. */
  readonly keys: () => readonly string[];
  /** Forces heartbeat-style keys to expire, simulating elapsed time. */
  expireAll(): void;
}

export function createMemoryRedisHub(): MemoryRedisHub {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, { value: string; expiresAt?: number }>();
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const live = (key: string): boolean => {
    const entry = strings.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      strings.delete(key);
      return false;
    }
    return true;
  };

  return {
    keys: () => [...new Set([...hashes.keys(), ...sets.keys(), ...strings.keys()])].sort(),
    expireAll: () => {
      for (const [key, entry] of strings) {
        if (entry.expiresAt !== undefined) strings.delete(key);
      }
    },
    transport: () => {
      const handlers = new Map<string, (message: string) => void>();
      let closed = false;
      const listener = (channel: string, message: string) => {
        if (closed) return;
        const handler = handlers.get(channel);
        if (handler) queueMicrotask(() => handler(message));
      };
      bus.on("message", listener);
      const transport: RealtimeRedis = {
        kind: "ship.realtime-redis",
        publish: async (channel, message) => {
          bus.emit("message", channel, message);
        },
        subscribe: async (channel, handler) => {
          handlers.set(channel, handler);
        },
        unsubscribe: async (channel) => {
          handlers.delete(channel);
        },
        hset: async (key, field, value) => {
          const hash = hashes.get(key) ?? new Map<string, string>();
          hash.set(field, value);
          hashes.set(key, hash);
        },
        hdel: async (key, ...fields) => {
          const hash = hashes.get(key);
          for (const field of fields) hash?.delete(field);
          if (hash?.size === 0) hashes.delete(key);
        },
        hgetall: async (key) => Object.fromEntries(hashes.get(key) ?? []),
        sadd: async (key, ...members) => {
          const set = sets.get(key) ?? new Set<string>();
          for (const member of members) set.add(member);
          sets.set(key, set);
        },
        srem: async (key, ...members) => {
          const set = sets.get(key);
          for (const member of members) set?.delete(member);
          if (set?.size === 0) sets.delete(key);
        },
        smembers: async (key) => [...(sets.get(key) ?? [])],
        set: async (key, value, ttlMs) => {
          strings.set(key, {
            value,
            ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
          });
        },
        exists: async (key) => live(key) || hashes.has(key) || sets.has(key),
        del: async (...keys) => {
          for (const key of keys) {
            hashes.delete(key);
            sets.delete(key);
            strings.delete(key);
          }
        },
        ping: async () => undefined,
        close: async () => {
          closed = true;
          bus.off("message", listener);
        },
      };
      return Object.freeze(transport);
    },
  };
}

export function isRealtimeRedis(value: unknown): value is RealtimeRedis {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.realtime-redis" &&
    typeof Reflect.get(value, "publish") === "function" &&
    typeof Reflect.get(value, "subscribe") === "function"
  );
}

export interface RealtimeKeys {
  readonly events: string;
  readonly gateways: string;
  gateway(gatewayId: string): string;
  gatewayMembers(gatewayId: string): string;
  presence(channelId: string, scopeKey: string): string;
}

export function realtimeKeys(prefix = "ship:realtime"): RealtimeKeys {
  return Object.freeze({
    events: `${prefix}:events`,
    gateways: `${prefix}:gateways`,
    gateway: (gatewayId: string) => `${prefix}:gateway:${gatewayId}`,
    gatewayMembers: (gatewayId: string) => `${prefix}:gateway:${gatewayId}:members`,
    presence: (channelId: string, scopeKey: string) =>
      `${prefix}:presence:${channelId}:${scopeKey}`,
  });
}
