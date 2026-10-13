# WebSockets

> **Compatibility feature:** this WebSocket implementation remains available
> from the monolithic v4 package. WebSockets are not currently part of the
> focused operation contract or its GA claim.

The `@hono/node-ws` adapter, subprotocol-header authentication (the framework's locked default), connection lifecycle, and what changes for React Native and edge runtimes.

## Subprotocol-header auth — the locked default

Every other WebSocket auth pattern has problems:

- **`?token=...` URL param** — leaks into server access logs, proxy logs, browser history. The token is a credential; logging it as part of a URL is a slow-burn leak.
- **Cookie auth** — works for same-origin web only. React Native's WebSocket doesn't ship cookies on handshakes; cross-origin cookies don't either.
- **First-message handshake** — open the socket, then send `{ type: "auth", token: "..." }` as the first message. Introduces an authenticated-but-resourceful window before auth completes; complicates state machines.

The framework uses the `Sec-WebSocket-Protocol` header. The client opens with two subprotocols:

```ts
new WebSocket(url, ["ship-api.v1", `bearer.${token}`]);
```

The server parses the header, extracts the bearer token, runs the same `AuthProvider` chain that handles HTTP auth, and only completes the upgrade if it succeeds. Proper Authorization-header semantics, no leakage, no intermediate state, supported by every WebSocket client (including RN).

## Parsing the header

```ts
import { extractWsAuth } from "@sixthsummit/ship-api/http/ws/auth";

const result = extractWsAuth(c.req.header("sec-websocket-protocol"));
// result.protocols: string[]            — every subprotocol presented
// result.bearerToken: string | null     — extracted from "bearer.<token>"
// result.selectedSubprotocol: string|null — first non-bearer protocol; server echoes back
```

The parser:

- Splits the comma-separated header into individual subprotocols.
- For each one starting with `bearer.` (case-insensitive), extracts the token. Uses the first one; ignores subsequent.
- Tracks the first non-bearer protocol as the "selected" one.

The server's upgrade response **must** include `Sec-WebSocket-Protocol: <selectedSubprotocol>` if the client offered any non-bearer protocols — otherwise the browser will reject the upgrade. The bearer protocol is a credential, not a real protocol; don't echo it back.

## Full upgrade authentication

```ts
import { authenticateWsUpgrade } from "@sixthsummit/ship-api/http/ws/auth";

app.get("/socket", async (c) => {
  const headers = Object.fromEntries(
    [...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
  );

  const result = await authenticateWsUpgrade({
    headers,
    provider,                       // your AuthProvider
    optional: false,                // require auth for upgrade
  });

  if (!result.ok) {
    return c.body(null, result.status);    // 401 or 403
  }

  // Hand off to the WebSocket adapter (you'd use @hono/node-ws here)
  return upgradeWebSocket({
    onOpen: (event, ws) => { /* ... */ },
    onMessage: (event, ws) => { /* ... */ },
    onClose: () => { /* ... */ },
    onError: (event) => { /* ... */ },
    selectedProtocol: result.selectedSubprotocol,
    user: result.account,
    claims: result.claims,
  });
});
```

`authenticateWsUpgrade` runs the provider chain and returns a verdict — `{ ok: true, account, claims, selectedSubprotocol }` on success or `{ ok: false, status: 401 | 403, reason }` on failure. The function doesn't touch the socket; the caller decides whether to upgrade or reject.

Status codes:

- **401** — no token, invalid token, expired token, signature failure, etc.
- **403** — token verifies but the resolved account isn't permitted (`onUnknownAccount: "reject"`, etc.).

## Lifecycle handlers

The framework ships the security primitives (extract + authenticate) but leaves the handler shape to `@hono/node-ws` and your application code. A typical wiring:

```ts
import { upgradeWebSocket } from "@hono/node-ws";

const sockets = new Map<string, ServerWebSocket>();   // user-id → ws (one per user)

app.get(
  "/socket",
  upgradeWebSocket(async (c) => {
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    const result = await authenticateWsUpgrade({ headers, provider });
    if (!result.ok) throw new HTTPException(result.status, { message: result.reason });

    return {
      onOpen(_event, ws) {
        const userId = result.account!.id;
        sockets.set(userId, ws);
        ws.send(JSON.stringify({ type: "connected" }));
      },
      onMessage(event, ws) {
        const msg = JSON.parse(event.data.toString());
        // route messages...
      },
      onClose() {
        sockets.delete(result.account!.id);
      },
      onError(event) {
        logger.error({ err: event }, "ws.error");
      },
      protocol: result.selectedSubprotocol ?? undefined,
    };
  }),
);
```

The framework's contract starts and ends at authentication. Connection state — per-user channels, broadcast, room-based fan-out, message routing — is consumer code. The right shape depends on your app: a chat app wants per-user channels with broadcast; a real-time dashboard wants topic subscriptions; a collaborative editor wants per-document rooms.

## Sending messages

```ts
ws.send(JSON.stringify({ type: "message", content: "hello" }));      // text
ws.send(buffer);                                                      // binary
```

`@hono/node-ws` exposes the standard browser-WebSocket API on the server side. Backpressure is handled by Node's stream layer — `ws.send()` returns when the message is buffered in the socket-write queue, not when delivery is acknowledged. For very-high-throughput connections, monitor `ws.bufferedAmount` and pause sends when it grows.

## Ping / pong

WebSockets have built-in ping/pong frames for keep-alive. `@hono/node-ws` handles incoming pings automatically (responds with pongs). For *outgoing* pings to detect dead connections:

```ts
const interval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.ping();
  } else {
    clearInterval(interval);
  }
}, 30_000);
```

Browsers don't expose `ping` to client JS — clients can't initiate pings. Server-initiated pings (with a timeout for the pong response) are the standard pattern for detecting silently-dead clients.

## Broadcasting to a room

A common pattern: messages from one connection should fan out to others in the same "room" (same chat, same document, same channel).

```ts
const rooms = new Map<string, Set<ServerWebSocket>>();

function joinRoom(roomId: string, ws: ServerWebSocket) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(ws);
}

function leaveRoom(roomId: string, ws: ServerWebSocket) {
  rooms.get(roomId)?.delete(ws);
  if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
}

function broadcast(roomId: string, message: unknown, except?: ServerWebSocket) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const ws of room) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
```

This is in-process. For multi-replica deployments, use Redis Pub/Sub (or another message bus) to fan out across pods:

```ts
// On message receive on any pod:
await redis.publish(`room:${roomId}`, JSON.stringify(message));

// Each pod subscribes:
redis.subscribe(`room:*`);
redis.on("pmessage", (pattern, channel, data) => {
  const roomId = channel.replace("room:", "");
  broadcast(roomId, JSON.parse(data));    // local fan-out
});
```

The framework doesn't ship a room/broadcast manager because the right shape is application-specific. The primitives (auth + connection management via `@hono/node-ws`) are enough.

## React Native compatibility

RN's `WebSocket` API supports the `protocols` parameter (the second argument), so subprotocol-header auth works natively:

```ts
const ws = new WebSocket(`${WS_URL}/socket`, [
  "ship-api.v1",
  `bearer.${token}`,
]);

ws.onopen = () => { /* ... */ };
ws.onmessage = (event) => { /* ... */ };
ws.onclose = () => { /* ... */ };
ws.onerror = (event) => { /* ... */ };
```

No polyfill needed. See [cross-framework/react-native-expo](../cross-framework/react-native-expo.md) for more.

## Edge runtime caveat

Cloudflare Workers WebSockets use a different model — `fetch` returns a `Response` with a `WebSocket` pair, and you accept the upgrade via `webSocketPair()`. The current adapter (`@hono/node-ws`) is **Node.js only**. A Workers adapter would need different wiring.

If you're targeting Cloudflare Workers, there are two paths:

- **Use Cloudflare Durable Objects for stateful WebSocket connections.** Each Durable Object holds connection state for a room or user; horizontal scaling is automatic. The framework's auth primitives (`extractWsAuth`, `authenticateWsUpgrade`) work because they're stateless functions; the upgrade-completion code differs.
- **Use a separate WebSocket service.** Run the WebSocket layer on Node (the framework's default) and the rest of the app on Workers. Connect via your message bus.

The framework's locked Workers-compatibility surface is HTTP only in v4.0; full WebSocket parity for edge is a v4.x roadmap item.

## Operational concerns

**Token-in-header logging.** Some load balancers log the `Sec-WebSocket-Protocol` header. Firebase ID tokens are short-lived (~1 hour), bounding leakage; longer-lived tokens (your own session JWTs with hours of TTL) are riskier. Configure proxies to redact the header where possible.

**Connection limits.** Each open socket is a file descriptor. Default Linux per-process FD limit is 1024 — bump via `ulimit -n` for production. Each Node process can hold tens of thousands of connections with appropriate tuning; the framework doesn't impose limits.

**Auth on reconnect.** WebSocket connections can be long-lived but tokens expire. When the access token expires, the server can either close the connection (forcing reconnect with a fresh token) or accept that long-lived connections persist past the token's TTL — a tradeoff between security (fresher tokens) and UX (no reconnect storms). The pattern depends on your threat model.

**Don't replicate HTTP auth in messages.** Once the upgrade is authenticated, every message on that socket is from the authenticated user. Don't re-validate per message; that's wasted work. If you need to authorize specific actions (different actions need different permissions), check at action time using the `account` you stored at upgrade.

## Source

- [`packages/core/src/http/ws/auth.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/ws/auth.ts) — `extractWsAuth`, `authenticateWsUpgrade`
- [`@hono/node-ws`](https://hono.dev/docs/helpers/websocket) — Hono's Node WebSocket adapter
- [authentication](../concepts/authentication.md) — the `AuthProvider` interface that `authenticateWsUpgrade` runs through
