# Realtime Subscriptions

Subscribing to ShipAPI's declared realtime publication surface with `@sixthsummit/ship-angular/realtime`. The entry is signal-first, typed from the manifest's `channels`, and is a no-op during server-side rendering.

This is a **declared** capability: the application can only subscribe to channels the ShipAPI manifest projects. There is no ad-hoc topic string and no client-side room naming.

## When to use which entrypoint

| Entrypoint  | Use it for                                                                    |
| ----------- | ----------------------------------------------------------------------------- |
| `/realtime` | Server-published events on channels the ShipAPI manifest declares             |
| `/socket`   | A single bounded WebSocket bound to one declared `socket` transport operation |
| `/stream`   | A one-directional SSE response for one declared `stream` transport operation  |

`/realtime` is a fan-out subscription surface; `/socket` and `/stream` are per-operation transports. They do not replace each other.

## Install the transport

Socket.IO is the first transport. It is an **optional peer dependency of the `./realtime` entry only** — applications that never import `./realtime` install nothing and their bundles contain no Socket.IO code.

```bash
pnpm add socket.io-client
```

The adapter imports `socket.io-client` lazily, so the entry itself loads without it when you supply your own transport.

## Declare the channel types

The runtime manifest carries a schema _reference_ per channel, not the payload type. Supply the payload types with a contract interface that mirrors the manifest — the same split `/operations` uses between `OperationTypeContract` and the browser client manifest.

```ts
// app-channels.ts
export interface AppChannels {
  readonly channels: {
    readonly 'account.updated': {
      readonly scope: 'actor';
      readonly payload: { readonly accountId: string; readonly balance: number };
      readonly presence: false;
    };
    readonly 'room.messages': {
      readonly scope: 'resource';
      readonly payload: { readonly roomId: string; readonly text: string };
      readonly presence: true;
    };
  };
}
```

`scope` selects how the gateway authorizes `scopeKey`:

| Scope      | `scopeKey` is                | Authorized by                         |
| ---------- | ---------------------------- | ------------------------------------- |
| `actor`    | the signed-in actor's own id | the gateway (other ids are rejected)  |
| `tenant`   | a tenant id                  | the app's `TenantScopeAuthority`      |
| `resource` | an opaque resource reference | the channel's `authorizeSubscription` |

## Provide the client

```ts
// app.config.ts
import { provideShipRealtime } from '@sixthsummit/ship-angular/realtime';
import { clientContract } from '@my-org/api-client';
import type { AppChannels } from './app-channels';

export const appConfig: ApplicationConfig = {
  providers: [
    provideShipRealtime<AppChannels>({
      url: environment.realtimeUrl,
      credential: () => auth.capabilities.bearerToken.getToken(),
      manifest: clientContract,
    }),
  ],
};
```

- `url` is the gateway origin. The transport appends the protocol's `/ship` namespace.
- `credential` is called **before every connection attempt**, so a reconnect always carries a freshly refreshed token. It returns the same bearer credential the HTTP API accepts.
- `manifest` is the ShipAPI client manifest. Its `channels` map is validated on construction; an operation whose `publishes` names an undeclared channel is a wiring defect and throws immediately.

Pass a typed token as the second argument when you want `inject()` without a cast, exactly as with `provideShipApiClient`.

## Subscribe

```ts
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { injectRealtime } from '@sixthsummit/ship-angular/realtime';
import type { AppChannels } from './app-channels';

@Component({
  selector: 'app-room',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (message(); as text) {
      <p>{{ text }}</p>
    }
    <p>{{ online() }} online</p>
  `,
})
export class Room {
  private realtime = injectRealtime<AppChannels>();
  private subscription = this.realtime.subscribe('room.messages', 'room-42');

  readonly message = computed(() => this.subscription.latest()?.text);
  readonly online = computed(() => this.subscription.presence()?.count ?? 0);
}
```

`subscribe()` returns signals, never observables:

| Member            | Type                                                       | Notes                                                              |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `latest`          | `Signal<Payload \| undefined>`                             | Most recent payload; `undefined` before the first event            |
| `events(handler)` | `(handler) => () => void`                                  | Per-event callback with `seq` and `publishedAt`; returns a remover |
| `presence`        | `Signal<{ count, members } \| undefined>`                  | **Only present** when the channel declares `presence: true`        |
| `dropped`         | `Signal<number>`                                           | Running total the gateway reported dropping                        |
| `status`          | `Signal<'pending' \| 'active' \| 'forbidden' \| 'closed'>` |                                                                    |
| `error`           | `Signal<RealtimeSubscriptionErrorCode \| undefined>`       | Why the subscription stopped                                       |
| `unsubscribe()`   | `void`                                                     | Stops delivery and tells the gateway                               |

Accessing `.presence` on a channel declared `presence: false` is a compile error.

## Sequence numbers

`seq` is per `(channel, scopeKey)` and monotonic **within one gateway process**. Treat gaps as expected (coalesced or dropped batches) and resets as expected (gateway restart). Never use `seq` as a durable cursor; refetch through the HTTP operation when `dropped()` grows.

## Refused subscriptions

| `error()` code           | `status()`  | Meaning                                                       |
| ------------------------ | ----------- | ------------------------------------------------------------- |
| `CHANNEL_NOT_FOUND`      | `closed`    | Not declared by the manifest, or unknown to the gateway       |
| `SUBSCRIPTION_FORBIDDEN` | `forbidden` | The actor may not observe that scope                          |
| `INVALID_SCOPE`          | `forbidden` | The `scopeKey` is not valid for the channel's scope kind      |
| `RATE_LIMITED`           | `closed`    | Too many subscriptions; subscribe again later                 |
| `ACK_TIMEOUT`            | `closed`    | The gateway did not acknowledge in `ackTimeoutMs`             |
| `CONNECTION_REFUSED`     | `forbidden` | The gateway refused the connection with `AUTHORIZATION_ERROR` |

All six are terminal for that subscription object: call `subscribe()` again to retry. They are **not** silently retried, so a forbidden subscription cannot turn into a reconnect loop.

## Connection lifecycle

`status` on the client is `'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'`.

- The link opens lazily on the first `subscribe()` and closes once the last live subscription ends.
- Releasing the last subscription waits for the gateway's `ship:unsubscribe` ack — bounded by `ackTimeoutMs` — before closing the idle link, so the final unsubscribe is never lost to the disconnect; `unsubscribe()` itself still returns immediately, and `close()` closes without waiting.
- On any disconnect — including the protocol's `ship:slow-subscriber` reason — the client backs off, resolves a fresh credential, reconnects, and re-issues `ship:subscribe` for every live subscription. Gateway state is never assumed to survive.
- `AUTHORIZATION_ERROR` is terminal: the same credential will keep being refused, so the client stops and reports `status() === 'error'`.
- Reconnect, backoff, credential refresh and resubscribe-all live in the client, not the transport, so every transport behaves identically.

Tune the backoff with `reconnect: { minDelayMs, maxDelayMs }` and the ack budget with `ackTimeoutMs`.

## Server-side rendering

`provideShipRealtime` is a no-op on the server. `injectRealtime()` returns a client whose `status()` is `'closed'`, and `subscribe()` returns an already-closed subscription without opening a socket. No guard is needed in component code; the browser render opens the link. The browser conformance gate asserts that an SSR render leaves the gateway's connection count unchanged.

## Testing with your own transport

`ShipRealtimeTransport` is the whole adapter boundary: open a link, expose `subscribe` / `unsubscribe` / `presenceSnapshot`, push `onEvent` / `onPresence` / `onDropped` / `onDisconnect`. Pass one to `transport` to drive a component's realtime state deterministically, with no server and no Socket.IO.

```ts
provideShipRealtime<AppChannels>({
  url: 'https://gateway.test',
  credential: () => 'test-token',
  manifest,
  transport: async request => ({
    subscribe: async () => ({ ok: true, subscriptionId: 'test-1' }),
    unsubscribe: async () => ({ ok: true }),
    presenceSnapshot: async () => ({ ok: true, count: 1, members: ['actor-1'] }),
    close: () => undefined,
  }),
});
```

Nothing in the public subscription API is Socket.IO-shaped — no rooms, namespaces, or acks — so a raw-WebSocket transport can be added later behind the same API.

## Related

- [ADR 0005: Declared realtime publication](../architecture/decisions/0005-declared-realtime-publication.md)
- [ADR 0002: Operation client contract](../architecture/decisions/0002-operation-client-contract.md)
