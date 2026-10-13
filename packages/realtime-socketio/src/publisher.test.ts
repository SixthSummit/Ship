import { defineChannel } from "@sixthsummit/ship-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodeEnvelope } from "./envelope.js";
import { createRealtimePublisher, withTimeout } from "./publisher.js";
import { createMemoryRedisHub, type RealtimeRedis, realtimeKeys } from "./redis.js";

const feed = defineChannel({
  id: "activity.feed",
  scope: "actor",
  payload: z.object({ n: z.number() }),
});
const other = defineChannel({
  id: "other.feed",
  scope: "actor",
  payload: z.object({ n: z.number() }),
});

describe("createRealtimePublisher", () => {
  it("hands publications to Redis in order without awaiting the round trip", async () => {
    const hub = createMemoryRedisHub();
    const consumer = hub.transport();
    const received: string[] = [];
    await consumer.subscribe(realtimeKeys().events, (message) => received.push(message));
    const publisher = createRealtimePublisher({
      redis: hub.transport(),
      channels: [feed],
      id: "api",
    });

    const started = performance.now();
    await publisher.publish(feed, "alice", { n: 1 });
    await publisher.publish(feed, "alice", { n: 2 });
    expect(performance.now() - started).toBeLessThan(50);
    expect(publisher.adapter).toBe("socket.io-redis");
    await publisher.flush();
    expect(publisher.pending).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received.map((raw) => decodeEnvelope(raw))).toEqual([
      expect.objectContaining({
        kind: "message",
        channel: "activity.feed",
        scopeKey: "alice",
        payload: { n: 1 },
        origin: "api",
      }),
      expect.objectContaining({ payload: { n: 2 } }),
    ]);
    await expect(publisher.publish(other, "alice", { n: 1 })).rejects.toMatchObject({
      code: "SHIP_REALTIME_CHANNEL_INVALID",
      channelId: "other.feed",
    });
    expect(await publisher.health()).toEqual({
      ok: true,
      adapter: "socket.io-redis",
      detail: "pending=0",
    });
    await publisher.close();
    expect(await publisher.health()).toEqual({
      ok: false,
      adapter: "socket.io-redis",
      detail: "closed",
    });
    await expect(publisher.publish(feed, "alice", { n: 3 })).rejects.toMatchObject({
      code: "SHIP_REALTIME_BACKEND_UNAVAILABLE",
    });
    expect(publisher.send({ ...(decodeEnvelope(received[0] as string) as never) })).toBe(false);
  });

  it("drops when the bounded queue is full or Redis rejects the write", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const redis: RealtimeRedis = {
      ...createMemoryRedisHub().transport(),
      publish: async () => {
        calls += 1;
        if (calls === 1) await gate;
        if (calls === 3) throw new Error("redis down");
      },
      ping: async () => {
        throw new Error("no pong");
      },
    };
    const dropped = vi.fn();
    const publisher = createRealtimePublisher({ redis, maxPending: 3, onDropped: dropped });
    await publisher.publish(feed, "alice", { n: 1 });
    await publisher.publish(feed, "alice", { n: 2 });
    await publisher.publish(feed, "alice", { n: 3 });
    await publisher.publish(feed, "alice", { n: 4 });
    expect(publisher.pending).toBe(3);
    expect(dropped).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { n: 4 } }),
      "queue-full",
    );
    release();
    await publisher.flush();
    expect(dropped).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { n: 3 } }),
      "redis-error",
      expect.any(Error),
    );
    expect(calls).toBe(3);
    expect(await publisher.health()).toMatchObject({ ok: false, detail: "no pong" });
    await publisher.close();
  });

  it("withTimeout rejects slow promises", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5)).rejects.toThrow(/timed out/u);
    await expect(withTimeout(Promise.resolve(1), 5)).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error("x")), 5)).rejects.toThrow("x");
  });
});
