import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPresenceStore } from "./presence.js";
import {
  createIoredisTransport,
  createMemoryRedisHub,
  isRealtimeRedis,
  realtimeKeys,
} from "./redis.js";

describe("createMemoryRedisHub", () => {
  it("shares hashes, sets, strings, and pub/sub between transports", async () => {
    const hub = createMemoryRedisHub();
    const a = hub.transport();
    const b = hub.transport();
    const received: string[] = [];
    await b.subscribe("events", (message) => received.push(message));
    await a.publish("events", "hello");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(["hello"]);

    await a.hset("h", "f1", "v1");
    await a.hset("h", "f2", "v2");
    expect(await b.hgetall("h")).toEqual({ f1: "v1", f2: "v2" });
    await b.hdel("h", "f1");
    await b.hdel("h", "f2");
    expect(await a.hgetall("h")).toEqual({});
    await a.sadd("s", "x", "y");
    await b.srem("s", "x");
    expect(await a.smembers("s")).toEqual(["y"]);
    await a.set("k", "1", 50);
    expect(await b.exists("k")).toBe(true);
    hub.expireAll();
    expect(await b.exists("k")).toBe(false);
    await a.set("k2", "1", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await b.exists("k2")).toBe(false);
    await a.set("k3", "1");
    expect(await b.exists("k3")).toBe(true);
    expect(hub.keys()).toEqual(["k3", "s"]);
    await a.del("k3", "s");
    expect(hub.keys()).toEqual([]);
    await a.ping();
    await b.unsubscribe("events");
    await a.publish("events", "ignored");
    await b.close();
    await a.publish("events", "ignored too");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual(["hello"]);
    expect(isRealtimeRedis(a)).toBe(true);
    expect(isRealtimeRedis({})).toBe(false);
  });
});

describe("createIoredisTransport", () => {
  it("maps the narrow surface onto ioredis clients without closing borrowed ones", async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string, result: unknown = undefined) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return result;
      };
    const subscriber = Object.assign(new EventEmitter(), {
      status: "ready",
      subscribe: record("subscribe"),
      unsubscribe: record("unsubscribe"),
      ping: record("subscriber-ping", "PONG"),
      quit: record("quit"),
    });
    const commands = {
      status: "ready",
      publish: record("publish", 1),
      hset: record("hset"),
      hdel: record("hdel"),
      hgetall: record("hgetall", { a: "b" }),
      sadd: record("sadd"),
      srem: record("srem"),
      smembers: record("smembers", ["m"]),
      set: record("set"),
      exists: record("exists", 1),
      del: record("del"),
      ping: record("ping", "PONG"),
      quit: record("quit"),
    };
    const transport = createIoredisTransport({ clients: { commands, subscriber } as never });
    const handler = vi.fn();
    await transport.subscribe("events", handler);
    subscriber.emit("message", "events", "payload");
    subscriber.emit("message", "other", "ignored");
    expect(handler).toHaveBeenCalledWith("payload");
    expect(handler).toHaveBeenCalledTimes(1);
    await transport.publish("events", "m");
    await transport.hset("h", "f", "v");
    await transport.hdel("h", "f");
    await transport.hdel("h");
    expect(await transport.hgetall("h")).toEqual({ a: "b" });
    await transport.sadd("s", "x");
    await transport.sadd("s");
    await transport.srem("s", "x");
    await transport.srem("s");
    expect(await transport.smembers("s")).toEqual(["m"]);
    await transport.set("k", "v");
    await transport.set("k", "v", 100);
    expect(await transport.exists("k")).toBe(true);
    await transport.del("k");
    await transport.del();
    await transport.ping();
    await transport.unsubscribe("events");
    await transport.close();
    expect(calls).toEqual([
      ["subscribe", "events"],
      ["publish", "events", "m"],
      ["hset", "h", "f", "v"],
      ["hdel", "h", "f"],
      ["hgetall", "h"],
      ["sadd", "s", "x"],
      ["srem", "s", "x"],
      ["smembers", "s"],
      ["set", "k", "v"],
      ["set", "k", "v", "PX", 100],
      ["exists", "k"],
      ["del", "k"],
      ["ping"],
      ["subscriber-ping"],
      ["unsubscribe", "events"],
    ]);
    subscriber.status = "end";
    await expect(transport.ping()).rejects.toThrow("pub/sub connection is not ready");
  });
});

describe("realtimeKeys", () => {
  it("namespaces every key under the prefix", () => {
    const keys = realtimeKeys("t");
    expect(keys.events).toBe("t:events");
    expect(keys.gateways).toBe("t:gateways");
    expect(keys.gateway("g")).toBe("t:gateway:g");
    expect(keys.gatewayMembers("g")).toBe("t:gateway:g:members");
    expect(keys.presence("a.b", "s")).toBe("t:presence:a.b:s");
    expect(realtimeKeys().events).toBe("ship:realtime:events");
  });
});

describe("createPresenceStore", () => {
  it("counts distinct actors across gateways and sweeps dead gateways", async () => {
    const hub = createMemoryRedisHub();
    const keys = realtimeKeys();
    const one = createPresenceStore({
      redis: hub.transport(),
      keys,
      gatewayId: "g1",
      ttlMs: 60_000,
    });
    const two = createPresenceStore({
      redis: hub.transport(),
      keys,
      gatewayId: "g2",
      ttlMs: 60_000,
    });
    await one.heartbeat();
    await two.heartbeat();

    expect(await one.join("a.b", "s", "c1", "alice")).toEqual({ changed: true, count: 1 });
    expect(await two.join("a.b", "s", "c2", "alice")).toEqual({ changed: false, count: 1 });
    expect(await two.join("a.b", "s", "c3", "bob")).toEqual({ changed: true, count: 2 });
    expect(await one.snapshot("a.b", "s")).toEqual(["alice", "bob"]);
    expect(await one.leave("a.b", "s", "c1", "alice")).toEqual({ changed: false, count: 2 });
    expect(await one.snapshot("a.b", "s")).toEqual(["alice", "bob"]);

    expect(await one.sweep()).toEqual([]);
    hub.expireAll();
    await one.heartbeat();
    expect(await one.sweep()).toEqual([
      { channelId: "a.b", scopeKey: "s", actorId: "alice", count: 1 },
      { channelId: "a.b", scopeKey: "s", actorId: "bob", count: 0 },
    ]);
    expect(await one.snapshot("a.b", "s")).toEqual([]);
    expect(await one.sweep()).toEqual([]);

    await one.join("a.b", "s", "c9", "carol");
    expect(await one.clear()).toEqual([
      { channelId: "a.b", scopeKey: "s", actorId: "carol", count: 0 },
    ]);
    expect(hub.keys()).toEqual([]);
  });

  it("ignores malformed member entries while sweeping", async () => {
    const hub = createMemoryRedisHub();
    const keys = realtimeKeys();
    const redis = hub.transport();
    await redis.sadd(keys.gateways, "dead");
    await redis.sadd(keys.gatewayMembers("dead"), "broken");
    const store = createPresenceStore({ redis, keys, gatewayId: "live", ttlMs: 1_000 });
    expect(await store.sweep()).toEqual([]);
    expect(await redis.smembers(keys.gateways)).toEqual([]);
  });
});
