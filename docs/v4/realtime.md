# Ship realtime wire protocol v1 (Socket.IO adapter) — canonical, both server (ship-api SAPI-109) and client (ship-angular) implement exactly this

## Manifest projection (ship-contract) — transport-neutral
channels: { [channelId]: { scope: "actor" | "tenant" | "resource", payload: <schemaRef>, presence: boolean } }
operations[id].publishes: string[] (channel ids)
No rooms/namespaces/transport detail in the manifest.

## Connection (Socket.IO)
Namespace: "/ship". Client connects with socket.io `auth: { credential: string }` where credential is the same bearer credential the HTTP API accepts (e.g. Firebase ID token). Server resolves it with the app's ActorResolver. Rejection is a `connect_error` whose `data` is `{ code: "AUTHENTICATION_ERROR" | "AUTHORIZATION_ERROR" | "AUTHENTICATION_UNAVAILABLE", message }`. Reconnect re-sends auth (client supplies a credential provider function so a refreshed token is used).

## Client -> server (all with ack callback)
- "ship:subscribe"   { channel: string, scopeKey: string }  -> ack { ok: true, subscriptionId: string } | { ok: false, code: "CHANNEL_NOT_FOUND" | "SUBSCRIPTION_FORBIDDEN" | "INVALID_SCOPE" | "RATE_LIMITED", message }
- "ship:unsubscribe" { subscriptionId: string }             -> ack { ok: true } | { ok: false, code: "UNKNOWN_SUBSCRIPTION" }
- "ship:presence.snapshot" { channel, scopeKey, cursor?: string, limit?: number } -> ack { ok: true, count: number, members: string[], nextCursor?: string } | { ok: false, code: "SUBSCRIPTION_FORBIDDEN" | "CHANNEL_NOT_FOUND" | "PRESENCE_DISABLED" | "INVALID_PAGE" }
- "ship:presence.online"   { channel, scopeKey, actorId: string }  -> ack { ok: true, online: boolean } | { ok: false, code: "SUBSCRIPTION_FORBIDDEN" | "CHANNEL_NOT_FOUND" | "PRESENCE_DISABLED" }
scopeKey semantics: actor channel => the actor's own id (server rejects other ids with INVALID_SCOPE); tenant channel => tenant id, authorized via the app's TenantScopeAuthority; resource channel => opaque resource ref string, authorized via the channel's authorizeSubscription.

## Server -> client
- "ship:event"    { channel, scopeKey, seq: number, publishedAt: string (ISO), payload }   — seq is per (channel, scopeKey) and monotonically increasing within one server process; clients must tolerate gaps (coalesce/drop) and resets (gateway restart).
- "ship:presence" { channel, scopeKey, kind: "joined" | "left", actorId: string, count: number }
- "ship:dropped"  { channel, scopeKey, dropped: number }  — sent once per drop batch when slowSubscriber = "drop-oldest".
- Disconnect with reason "ship:slow-subscriber" when slowSubscriber = "disconnect"; client may reconnect and resubscribe.
After reconnect the client re-issues ship:subscribe for every live subscription (server state is not assumed to survive).

## ship-angular client API ("./realtime" entry)
provideShipRealtime({ url: string, credential: () => string | Promise<string>, manifest }) ; injectRealtime() -> { status: Signal<"idle"|"connecting"|"open"|"reconnecting"|"closed"|"error">, subscribe<C extends keyof Channels>(channel: C, scopeKey: string): Subscription<C> }
Subscription<C> = { latest: Signal<Payload<C> | undefined>, events: (handler: (e: { seq, publishedAt, payload }) => void) => () => void, presence: Signal<{ count: number, members: string[] } | undefined> (only when manifest presence=true), dropped: Signal<number>, status: Signal<"pending"|"active"|"forbidden"|"closed">, unsubscribe(): void }
SSR: provider is a no-op; subscribe returns a subscription whose status is "closed" and never opens a socket.

---

## Server implementation notes (ship-api SAPI-109)

The text above is the canonical protocol and is reproduced verbatim from the
shared specification. The notes below record how `@sixthsummit/ship-realtime-socketio`
implements it and the places where Socket.IO cannot express the specification
literally. They add to the contract; they do not change it.

### Manifest shape (standardized)

`ship-contract` emits exactly one shape:

- `channels` is a keyed map: `{ [channelId]: { scope, payload, presence } }`
  where `payload` is a `ProjectedContractSchema` (`{ vendor, jsonSchema, codec? }`),
  the same schema reference used for operation inputs.
- `operations` stays an array; every operation carries `publishes: string[]`
  (channel ids, sorted). Manifests emitted before realtime existed omit both
  fields and still validate.

Nothing transport-shaped is projected: no rooms, namespaces, acks, event names,
coalesce windows, slow-subscriber policies, or authorization policies.

### Handshake

- Credential placement: `auth: { credential: string }`. The gateway materializes
  it as `Authorization: <scheme> <credential>` (scheme defaults to `Bearer`,
  configurable through `auth.authorizationScheme`) on a synthetic `Request`
  built from the handshake headers and runs the application's own
  `HonoCredentialAdapter` and `ActorResolver` (ADR-0004). Clients that can set
  headers may send the `Authorization` header directly; `auth.credential` wins
  when both are present.
- The resolver sees the synthetic operation `{ id: "realtime.connect", access }`
  with `access` defaulting to `authenticatedAccess()`
  (`auth.handshakeAccess` overrides it).
- Mapping: resolver `invalid-credential` -> `AUTHENTICATION_ERROR` (a stale or
  expired token lands here and is retryable with a fresh credential),
  `forbidden` -> `AUTHORIZATION_ERROR` (terminal), `unavailable` or a thrown
  resolver -> `AUTHENTICATION_UNAVAILABLE` (retryable).
- `X-Request-Id` on the handshake is honoured when it matches
  `^[A-Za-z0-9._:-]{1,128}$`; otherwise the gateway generates one.

### Subscriptions

- Scope keys must match `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`; anything else
  is `INVALID_SCOPE` before authorization runs.
- Every subscription requires a resolved actor. Actor channels admit only the
  actor's own id (`INVALID_SCOPE` otherwise), tenant channels are authorized by
  issuing an authentic `TenantScope` through the application's
  `TenantScopeAuthority`, resource channels call the channel's
  `authorizeSubscription(actor, resourceRef, { requestId })`. A policy that
  throws, a missing tenant authority, or a Redis failure fails closed as
  `SUBSCRIPTION_FORBIDDEN`; the wire never distinguishes "denied" from
  "could not decide".
- A repeated `ship:subscribe` for the same `(channel, scopeKey)` on one
  connection is idempotent and returns the existing `subscriptionId`.
- `createRealtimeGateway({ authorizeSubscription })` can read the current
  application grant before each subscription request, including one sent by an
  already-open socket whose handshake actor is stale. False, an unavailable
  grant source, or a three-second timeout returns `SUBSCRIPTION_FORBIDDEN` and
  creates no subscription. This is a fresh admission check, not a delivery
  fence: use `withAuthorizedDelivery` against the same writer-conflicting grant
  lock to suppress events queued near a committed revocation. Reconnect also
  requires the application's actor resolver to read current account status.
- Per-connection limits: `maxSubscriptionsPerConnection` (default 100) and a
  control-message token bucket (default 20/s, burst 40). Both answer
  `RATE_LIMITED` on `ship:subscribe`; on `ship:unsubscribe` and
  `ship:presence.snapshot` the limited reply uses that ack's own error code
  set (`UNKNOWN_SUBSCRIPTION` / `SUBSCRIPTION_FORBIDDEN`) with the message
  `Too many control messages`.
- Server-side subscription state does not survive a disconnect; the gateway
  releases every subscription of a closed connection and clients re-issue
  `ship:subscribe` after reconnecting.

### Events

- `seq` is assigned per `(channel, scopeKey)` by the gateway process that
  delivers the event, starting at 1 and resetting when that gateway restarts.
  Two gateways deliver the same publication with independent `seq` values.
  Coalesced publications consume one `seq` per delivery.
- `publishedAt` is the acceptance time recorded by the publishing process, so
  publish-to-deliver latency is measured against the publisher's clock.
- Gateway health checks both Redis command and pub/sub subscriber connections;
  a lost subscriber is degraded even if commands still answer `PING`.
- `ship:presence` events fire only when an actor's first connection joins or
  last connection leaves a scope key, across every gateway sharing the Redis.
  The joining subscriber receives its own `joined` event.

### Presence queries (ADR-0017 addendum)

- `ship:presence.snapshot` is paged. `count` is the whole membership of the
  scope key across every gateway; `members` is one page of sorted actor ids,
  at most `limit` long (default 100, clamped server-side to 1,000, never
  honoured above it); `nextCursor` is present exactly when more members
  follow and is sent back as `cursor` for the next page. The cursor is opaque
  to clients (it is the last actor id of the page, so a page boundary stays
  stable while members join or leave). Omitting `cursor` and `limit` returns
  the first default page, so pre-paging clients keep working. A `limit` that
  is not a positive integer, or a `cursor` that is not a non-empty string,
  is `INVALID_PAGE`.
- `ship:presence.online` answers whether `actorId` holds at least one live
  subscription to `(channel, scopeKey)` on any gateway: a multi-connection
  actor is online once, and offline only after its last connection closes.
  The actor asked about need not be the caller; the query is gated by the
  same subscription authorization as `ship:subscribe` and
  `ship:presence.snapshot`, fails closed as `SUBSCRIPTION_FORBIDDEN`, and is
  `PRESENCE_DISABLED` on a channel without presence. A missing or malformed
  `actorId` is `SUBSCRIPTION_FORBIDDEN`.
- Both queries share the control-message token bucket with `ship:subscribe`;
  the limited reply uses `SUBSCRIPTION_FORBIDDEN` with the message
  `Too many control messages`.
- `ship:dropped` is emitted once per drain batch after the peer catches up,
  per `(channel, scopeKey)`, when a `drop-oldest` channel overflowed the
  per-connection buffer (`sendBufferHighWaterMark`, default 1,000 events).

### Slow-subscriber disconnect (deviation)

Socket.IO cannot carry a custom disconnect reason on the wire: a server-side
`socket.disconnect()` always surfaces to the client as
`io server disconnect` (or `transport close` when the transport is torn down
first). The gateway therefore cannot literally deliver the reason
`ship:slow-subscriber`. Behaviour when a `disconnect` policy channel overflows:
the gateway clears the connection's queue and disconnects it; the client
observes `disconnect` with reason `io server disconnect` and should treat that
as "reconnect and resubscribe", exactly as the specification says. The constant
`SLOW_SUBSCRIBER_DISCONNECT_REASON` is exported for logs and metrics
(`ship.realtime.dropped{ship.realtime.drop_reason="slow-subscriber-disconnect"}`),
not for the wire.

### Acceptance is not delivery

`publish()` in the API process validates the payload against the channel
schema, hands the envelope to a bounded local queue, and returns. Redis
acceptance, gateway receipt, and socket writes happen afterwards. A full queue
or a Redis error drops the envelope and increments
`ship.realtime.dropped{ship.realtime.drop_reason="queue-full"|"redis-error"}`.

### Transactional publication (outbox composition, ADR-0017 addendum)

- A `transaction: "none"` operation publishes immediately, as above. A
  `transaction: "write"` operation that declares `publishes` records a
  publication intent in its own transaction through the framework outbox
  `ship-realtime.publication`; the mounted `ship-realtime` module's dispatcher
  (`ship-realtime.publication.dispatch`) performs the publish after commit.
  `transaction: "read"` operations cannot publish.
- **Delivery is eventual.** A subscriber sees the event only after the
  transaction commits *and* the dispatcher runs; the dispatcher's schedule is
  the delivery lag. Nothing on the wire distinguishes an immediate publication
  from a dispatched one.
- **Delivery is at-least-once.** A dispatcher that crashes after the backend
  accepted the publication but before recording completion republishes after
  the lease expires, so a client may receive the same event twice with
  distinct `seq` values. Clients that need exactly-once semantics must
  deduplicate on a payload-level identifier they control; `dedupeKey` only
  suppresses a duplicate intent at record time.
- `publishedAt` on a dispatched event is the dispatcher's acceptance time,
  not the transaction commit time.
- **Something must run the dispatcher.** The framework owns two runners over
  one dispatch pass (`dispatchRealtimePublications`):
  `startRealtimePublicationRunner(executor, { intervalMs?, maxPassesPerCycle?,
  backoff?, observer? })` for processes without the jobs capability (the
  kernel's adaptive outbox loop: a full batch is followed by the next pass at
  once, a short or empty one waits `intervalMs`), and
  `defineRealtimePublicationDispatchJob({ trigger, executor })` for processes
  that have it. Neither changes anything on the wire; both only decide the
  delivery lag. `createPublicationRunnerMetrics()` from
  `@sixthsummit/ship-realtime-socketio` records
  `ship.realtime.publication.runs`, `ship.realtime.publication.run.duration`
  and `ship.realtime.publication.records`.
