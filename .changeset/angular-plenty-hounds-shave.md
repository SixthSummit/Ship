---
'@sixthsummit/ship-angular': minor
---

Add the `./realtime` entrypoint for declared realtime publication.

`provideShipRealtime({ url, credential, manifest })` and `injectRealtime()` expose
subscriptions typed from the ShipAPI manifest's `channels`: `latest`, `events`,
`presence` (only on channels declared with `presence: true`), `dropped`, and `status`
as signals, with no RxJS in the public API. The client owns reconnect with backoff,
credential refresh on every attempt, resubscribe-all after a reconnect, and ack
timeouts, so transports stay interchangeable behind `ShipRealtimeTransport`.

Socket.IO is the first transport and is an **optional peer dependency of this entry
only** — it is imported lazily, the root entry never references it, and the bundle
gate proves applications that do not use `./realtime` pay nothing. The provider is a
no-op under SSR: `subscribe()` returns a closed subscription and no socket is opened.

See ADR 0005 and the "Realtime Subscriptions" guide.
