import { describe, expect, it, vi } from "vitest";
import { createConnectionQueue, type OutboundItem, type OutboundSocket } from "./connection.js";

function fakeSocket(): OutboundSocket & {
  readonly emitted: { event: string; payload: unknown }[];
  buffered: number;
  drain(): void;
  readonly disconnected: () => boolean;
} {
  const emitted: { event: string; payload: unknown }[] = [];
  let drainHandler: (() => void) | undefined;
  let disconnected = false;
  const socket = {
    emitted,
    buffered: 0,
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      socket.buffered += 1;
    },
    bufferedCount: () => socket.buffered,
    onDrain: (handler: () => void) => {
      drainHandler = handler;
      return () => {
        drainHandler = undefined;
      };
    },
    disconnect: () => {
      disconnected = true;
    },
    drain: () => {
      socket.buffered = 0;
      drainHandler?.();
    },
    disconnected: () => disconnected,
  };
  return socket;
}

function item(
  n: number,
  policy: OutboundItem["policy"] = "drop-oldest",
  channelId = "a.b",
): OutboundItem {
  return {
    event: "ship:event",
    payload: { n },
    channelId,
    scopeKey: "s",
    policy,
    publishedAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("createConnectionQueue", () => {
  it("checks the current grant before flushing queued events and disconnects on revocation", async () => {
    const socket = fakeSocket();
    socket.buffered = 10;
    let allowed = true;
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 4,
      lowWaterMark: 1,
      droppedEvent: "ship:dropped",
      authorizeDelivery: async () => allowed,
    });
    queue.push(item(1));
    allowed = false;
    socket.drain();
    await vi.waitFor(() => expect(socket.disconnected()).toBe(true));
    expect(socket.emitted).toHaveLength(0);
    expect(queue.closed).toBe(true);
  });

  it("fails closed when fresh delivery authorization errors", async () => {
    const socket = fakeSocket();
    const error = new Error("grant source unavailable");
    const onAuthorizationError = vi.fn();
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 4,
      droppedEvent: "ship:dropped",
      authorizeDelivery: async () => {
        throw error;
      },
      onAuthorizationError,
    });
    queue.push(item(1));
    await vi.waitFor(() => expect(socket.disconnected()).toBe(true));
    expect(socket.emitted).toHaveLength(0);
    expect(onAuthorizationError).toHaveBeenCalledWith(error);
  });
  it("writes only inside the authorized callback and rejects a late callback after timeout", async () => {
    const socket = fakeSocket();
    let deliverLate: (() => void) | undefined;
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 4,
      droppedEvent: "ship:dropped",
      withAuthorizedDelivery: async (_item, deliver) => {
        deliverLate = deliver;
        throw new Error("authorization deadline");
      },
    });
    queue.push(item(1));
    await vi.waitFor(() => expect(socket.disconnected()).toBe(true));
    deliverLate?.();
    expect(socket.emitted).toHaveLength(0);
  });

  it("enqueues while the application grant fence is held", async () => {
    const socket = fakeSocket();
    const sequence: string[] = [];
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 4,
      droppedEvent: "ship:dropped",
      withAuthorizedDelivery: async (_item, deliver) => {
        sequence.push("lock-held");
        deliver();
        sequence.push("lock-released");
      },
    });
    queue.push(item(1));
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(1));
    expect(sequence).toEqual(["lock-held", "lock-released"]);
    expect(socket.disconnected()).toBe(false);
  });
  it("writes straight through while the transport buffer is shallow", () => {
    const socket = fakeSocket();
    const delivered = vi.fn();
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 4,
      lowWaterMark: 2,
      droppedEvent: "ship:dropped",
      onDelivered: delivered,
    });
    queue.push(item(1));
    queue.push(item(2));
    expect(socket.emitted.map(({ payload }) => payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(delivered).toHaveBeenCalledTimes(2);
    queue.push(item(3));
    expect(queue.size).toBe(1);
    socket.drain();
    expect(queue.size).toBe(0);
    expect(socket.emitted).toHaveLength(3);
  });

  it("drops the oldest queued event and reports the batch once the peer catches up", () => {
    const socket = fakeSocket();
    socket.buffered = 10;
    const dropped = vi.fn();
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 3,
      lowWaterMark: 10,
      droppedEvent: "ship:dropped",
      onDropped: dropped,
    });
    for (let n = 1; n <= 6; n += 1) queue.push(item(n));
    expect(queue.size).toBe(3);
    expect(dropped).toHaveBeenCalledTimes(3);
    expect(socket.emitted).toHaveLength(0);
    socket.drain();
    expect(socket.emitted[0]?.payload).toEqual({ n: 4 });
    expect(socket.emitted.at(-1)).toEqual({
      event: "ship:dropped",
      payload: { channel: "a.b", scopeKey: "s", dropped: 3 },
    });
    expect(socket.emitted.filter((entry) => entry.event === "ship:dropped")).toHaveLength(1);
    queue.close();
    expect(queue.closed).toBe(true);
    queue.push(item(7));
    expect(queue.size).toBe(0);
  });

  it("disconnects when a channel declared the disconnect policy overflows", () => {
    const socket = fakeSocket();
    socket.buffered = 10;
    const onDisconnect = vi.fn();
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 2,
      droppedEvent: "ship:dropped",
      onDisconnect,
    });
    queue.push(item(1, "drop-oldest"));
    queue.push(item(2, "drop-oldest"));
    queue.push(item(3, "disconnect", "c.d"));
    expect(socket.disconnected()).toBe(true);
    expect(onDisconnect).toHaveBeenCalledWith("c.d", "s");
    expect(queue.closed).toBe(true);
    expect(queue.size).toBe(0);
  });

  it("keeps drop reports pending until the transport drains", () => {
    const socket = fakeSocket();
    socket.buffered = 10;
    const queue = createConnectionQueue({
      socket,
      highWaterMark: 1,
      lowWaterMark: 1,
      droppedEvent: "ship:dropped",
    });
    queue.push(item(1));
    queue.push(item(2));
    socket.drain();
    // The event write itself refilled the transport buffer, so the report waits.
    expect(socket.emitted.map((entry) => entry.event)).toEqual(["ship:event"]);
    socket.drain();
    expect(socket.emitted.map((entry) => entry.event)).toEqual(["ship:event", "ship:dropped"]);
  });
});
