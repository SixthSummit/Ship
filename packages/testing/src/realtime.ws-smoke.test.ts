/**
 * Raw WebSocket smoke fixture.
 *
 * Proves the RealtimeBackend contract is transport-neutral: a minimal `ws`
 * server (no Socket.IO, no Redis, no reconnect) drives the in-memory backend
 * with subscribe, one typed delivery, and unsubscribe. The production raw
 * WebSocket adapter is a follow-up; this fixture is the reversibility proof
 * required by ADR-0017.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { operationActor } from "@sixthsummit/ship-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { conformanceChannels, createInMemoryRealtimeBackend } from "./realtime.js";

type ClientMessage =
  | { readonly type: "subscribe"; readonly channel: string; readonly scopeKey: string }
  | { readonly type: "unsubscribe"; readonly subscriptionId: string };

const backend = createInMemoryRealtimeBackend({ channels: [conformanceChannels.feed] });
const server = createServer();
const sockets = new WebSocketServer({ server });
let connections = 0;

sockets.on("connection", (socket, request) => {
  connections += 1;
  const connectionId = `ws-${connections}`;
  // The fixture trusts a header; a real adapter runs the app's ActorResolver here.
  const actorId = request.headers["x-actor"];
  const actor = typeof actorId === "string" ? operationActor({ id: actorId }) : undefined;
  socket.on("message", async (raw) => {
    const message = JSON.parse(String(raw)) as ClientMessage;
    if (message.type === "subscribe") {
      const result = await backend.subscribe(
        {
          channelId: message.channel,
          scopeKey: message.scopeKey,
          actor,
          connectionId,
          requestId: `${connectionId}:subscribe`,
        },
        (event) => socket.send(JSON.stringify({ type: "event", ...event })),
      );
      socket.send(JSON.stringify({ type: "subscribed", ...result }));
      return;
    }
    await backend.unsubscribe(message.subscriptionId);
    socket.send(JSON.stringify({ type: "unsubscribed" }));
  });
  socket.on("close", () => void backend.disconnect(connectionId));
});

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) =>
    socket.once("message", (raw) => resolve(JSON.parse(String(raw)))),
  );
}

describe("raw WebSocket smoke over the in-memory backend", () => {
  beforeAll(async () => {
    server.listen(0);
    await once(server, "listening");
  });
  afterAll(async () => {
    sockets.close();
    server.close();
    await backend.close();
  });

  it("subscribes, receives one typed payload, and unsubscribes without Socket.IO", async () => {
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { "x-actor": "alice" } });
    await once(socket, "open");

    const subscribed = nextMessage(socket);
    socket.send(
      JSON.stringify({ type: "subscribe", channel: "conformance.feed", scopeKey: "alice" }),
    );
    const ack = await subscribed;
    expect(ack).toMatchObject({ type: "subscribed", ok: true, subscriptionId: expect.any(String) });

    const delivery = nextMessage(socket);
    await backend.publish(conformanceChannels.feed, "alice", { n: 7 });
    expect(await delivery).toMatchObject({
      type: "event",
      kind: "message",
      channelId: "conformance.feed",
      scopeKey: "alice",
      seq: 1,
      payload: { n: 7 },
    });

    const unsubscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId: ack.subscriptionId }));
    expect(await unsubscribed).toEqual({ type: "unsubscribed" });

    let extra = 0;
    socket.on("message", () => {
      extra += 1;
    });
    await backend.publish(conformanceChannels.feed, "alice", { n: 8 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(extra).toBe(0);

    const denied = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(denied, "open");
    const deniedAck = nextMessage(denied);
    denied.send(
      JSON.stringify({ type: "subscribe", channel: "conformance.feed", scopeKey: "alice" }),
    );
    expect(await deniedAck).toEqual({ type: "subscribed", ok: false, reason: "forbidden" });
    denied.close();
    socket.close();
  });
});
