# ADR-0017: Declare realtime publication as channels, publications, and a transport-neutral backend

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Channel declarations, subscription authorization, the `RealtimeBackend` adapter contract, the Socket.IO + Redis gateway adapter, presence, backpressure, and metrics
- **Related:** [ADR-0001](./0001-operation-centric-application-kernel.md) · [ADR-0004](./0004-credential-actor-and-access-boundary.md) · [ADR-0008](./0008-authorized-tenant-capabilities.md) · [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0010](./0010-declared-immediate-effects.md)
- **Numbering note:** 0014 (actor kinds and outbox) has merged; 0015 (jobs) and 0016 (streaming) are reserved by concurrent branches. Renumber on merge if a gap remains.

## Context

Applications on the compatibility line push realtime updates through ad hoc
Socket.IO rooms named after domain nouns, authenticated by a second code path,
with no place in the application graph, the client manifest, or impact
analysis. A subscriber could not tell which operations produce an event, a
reviewer could not tell which tenant boundary a room crossed, and the client
had no typed contract for payloads.

The kernel already owns the pieces a publication needs: operations declare
effects (ADR-0010), credentials resolve to actors through one resolver
(ADR-0004), and tenant selection is an authentic capability (ADR-0008).
Realtime publication should be declared with those primitives rather than as a
transport feature.

## Decision

### 1. Channels are kernel declarations

`defineChannel({ id, scope, payload, coalesce?, presence?, slowSubscriber?, authorizeSubscription? })`
creates an immutable channel. `scope` is `actor`, `tenant`, or `resource`:

- `actor` channels are addressed by the actor id and admit only that actor.
- `tenant` channels are addressed by an authentic `TenantScope` when
  publishing and authorized by the application's `TenantScopeAuthority` when
  subscribing. A raw tenant id is never accepted.
- `resource` channels are addressed by an opaque resource reference and must
  declare `authorizeSubscription(actor, resourceRef, context)`; omitting it is
  `SHIP_CHANNEL_AUTHORIZATION_REQUIRED`.

Modules own channels (`defineModule({ channels })`). Every channel carries a
`publication` token: an ordinary `effectDependency` (ADR-0010) whose resolved
value is a typed `ChannelPublisher`. An operation binds the token in
`dependencies` and names the channel in `publishes`. The compiler rejects an
undeclared channel (`SHIP_CHANNEL_UNDECLARED`), a cross-module publication
without an import (`SHIP_CHANNEL_IMPORT_REQUIRED`), a bound publication that is
not declared (`SHIP_OPERATION_PUBLISH_UNDECLARED`), a declared publication that
is not bound (`SHIP_OPERATION_PUBLISH_UNBOUND`), a duplicated channel id
(`SHIP_CHANNEL_ID_DUPLICATE`), and any publication from a `read` or `write`
operation (`SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN`).

The graph projects channels (id, module, scope, payload vendor, presence,
coalesce window, slow-subscriber policy, publishing operations) and each
operation's `publishes`. `ship-api inspect channel <id>` and
`ship-api affected channel <id>` read the same nodes. The client manifest
projects `channels: { [id]: { scope, payload, presence } }` and
`operations[].publishes`; it carries no transport detail.

### 2. The backend contract is transport-neutral

`RealtimeBackend` is a kernel interface: `publish(channel, scopeKey, payload)`,
`subscribe(request, sink)`, `unsubscribe(subscriptionId)`,
`disconnect(connectionId)`, optional `presence.snapshot(request)`, `health()`,
and `close()`. `RealtimePublishBackend` is the publish-only half an API
process needs. Subscription authorization is kernel-owned
(`createSubscriptionAuthorizer`) and fails closed; adapters call it, they do
not reimplement it. Coalescing is a kernel helper
(`createPublicationCoalescer`) so every adapter collapses bursts identically.

`@sixthsummit/ship-testing` ships an in-memory backend, `collectPublishes(app)`
(recompiles an application onto a recording backend), and
`realtimeBackendConformance()`, the executable contract every adapter runs.
Nothing in `packages/kernel` or `packages/contract` names rooms, namespaces,
acks, transports, or Socket.IO types.

### 3. Socket.IO first, reversible

Socket.IO is the first adapter because it is the installed base on the
compatibility line and in the Angular client. The choice is reversible by
construction: the in-memory backend and a raw-WebSocket smoke fixture
(`packages/testing/src/realtime.ws-smoke.test.ts`, Node `ws`, no Socket.IO,
no Redis, no reconnect) satisfy the same `RealtimeBackend` contract and pass
the same conformance suite. A production raw-WebSocket adapter is a follow-up
that changes only the transport package.

### 4. Subscriber authentication reuses ADR-0004

The gateway handshake materializes `auth.credential` as an `Authorization`
header on a synthetic `Request`, runs the application's `HonoCredentialAdapter`
and `ActorResolver` against the synthetic operation `realtime.connect`
(access defaults to `authenticated`), and maps resolver failures onto
`AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, and
`AUTHENTICATION_UNAVAILABLE`. There is no second auth path.

### 5. Gateway model

`@sixthsummit/ship-realtime-socketio` provides `createRealtimePublisher()` for
the API process and `createRealtimeGateway()` for gateway processes. Every
publication and presence change is one envelope on one Redis pub/sub channel.
Every gateway consumes the whole stream and delivers only to its own local
subscriptions, so cross-process fan-out needs no room synchronization and no
message is delivered twice. Scope-to-room mapping does not exist outside the
adapter; the adapter does not even use Socket.IO rooms for delivery.

`@socket.io/redis-adapter` is deliberately not attached. Fan-out already
travels over the publication stream; a second Redis-backed room broadcast would
double Redis egress for every event and create duplicate deliveries. Consumers
that broadcast with Socket.IO rooms themselves can still attach it to the
exposed `io` server.

Publishing never blocks the API process: `publish()` validates, enqueues into
a bounded local queue (default 10,000 envelopes), and returns. Backend
acceptance is not delivery. Queue overflow and Redis errors drop the envelope
and count `ship.realtime.dropped`.

### 6. Presence

`presence: true` tracks membership per scope key in a Redis hash whose fields
are `gateway:connection` and whose values are actor ids. Distinct values are
the present actors, so a multi-connection actor counts once; `left` fires when
the actor's last connection to that scope key closes, on any gateway. Each
gateway heartbeats a liveness key (default 5 s interval, 15 s TTL) and indexes
its own fields; survivors sweep the fields of a gateway whose key expired and
publish the resulting departures. Events carry only actor id, scope key, and
count. Snapshot reads are gated by the same subscription authorization as the
channel. The in-memory backend keeps the same semantics process-locally.

### 7. Backpressure and limits

Each connection has a bounded send buffer (`sendBufferHighWaterMark`, default
1,000 events) fed only while the engine.io write buffer is shallow. On overflow
the policy of the channel whose event overflowed applies: `drop-oldest` drops
the oldest queued event and reports one `ship:dropped` per drain batch;
`disconnect` clears the queue and disconnects the connection. Control messages
are rate limited per connection with a small internal token bucket (the
compatibility HTTP limiter lives in `packages/core`, which kernel adapters do
not import) and subscriptions are capped per connection.

### 8. Observability

Instruments are emitted through `@opentelemetry/api` via
`@sixthsummit/ship-observability-otel`'s framework meter with stable
attributes `ship.channel.id` and `ship.channel.scope`:
`ship.realtime.connections`, `ship.realtime.subscriptions`,
`ship.realtime.deliver.latency` (publish-to-socket-write, ms),
`ship.realtime.redis.lag` (publish-to-gateway-receipt, ms),
`ship.realtime.dropped` (`ship.realtime.drop_reason`), `ship.realtime.published`,
and `ship.realtime.delivered`. Latencies are measured against the publisher's
clock because envelopes carry `publishedAt`.

### 9. Transactional publishes compose with the outbox

Immediate publication is allowed only on `transaction: "none"` operations, the
same boundary ADR-0010 draws for every immediate effect. A transactional
operation will enqueue a publication intent through the durable outbox
(`defineOutbox` / `outboxDependency` / `defineOutboxDispatcher`, ADR-0014) and
the dispatcher, a `transaction: "none"` operation, will bind the channel
publication and publish after commit. The kernel does not grow its own
after-commit hook. The composition itself (a publication intent shape and a
dispatcher that publishes) is a follow-up; today the compiler diagnostic is the
contract: `SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN` is asserted by
`packages/kernel/src/realtime.test.ts`, and the composition is a clearly
marked TODO in that test and in `docs/UPGRADING.md`.

## Evidence

Multi-process integration (`packages/realtime-socketio/src/gateway.integration.test.ts`,
one API process, two gateway processes spawned as direct Node children,
`redis:7-alpine` through testcontainers, Apple Silicon laptop, 2026-09-18):

| Scenario | Result |
| --- | --- |
| Cross-process delivery | 3 publications from the API process delivered in order on both gateways with `seq` 1..3 |
| Presence dedupe and crash | One actor with a connection on each gateway counted once; SIGKILL of gateway B left the actor present through gateway A; a restarted gateway B read the surviving membership from Redis; the last connection closing produced exactly one `left` |
| Slow subscriber isolation | 4,000 × 2 KiB publications against one stalled peer: fast peer received all 4,500, stalled peer dropped 3,355 (reported once on drain), API `publish()` p95 0.005 ms versus 0.002 ms baseline |
| Disconnect policy | A stalled peer on a `disconnect` channel was disconnected after buffer overflow |
| Load, 500/s for 60 s | 30,000 published at an achieved 500/s; 30,000 delivered on each gateway (0 loss); `publish()` p50 0.021 ms, p95 0.080 ms, p99 0.171 ms, max 7.9 ms; end-to-end (publisher clock to client receipt) p50 1 ms, p95 3 ms, p99 12 ms on both gateways; no gateway errors |

The load figures above come from the suite running alone. Under `pnpm run
test:integration`, where it shares the machine with eleven PostgreSQL
integration files, the same run still delivered 30,000/30,000 with `publish()`
p95 0.142 ms, but end-to-end p95 rose to about 1 s: the gateway processes were
CPU-starved, not the publisher. The API-side hand-off is the invariant; the
end-to-end number is a property of the gateway host.

### How many gateways can share one Redis, and what breaks first

Every gateway subscribes to the single publication channel, so Redis pub/sub
egress is `publications/s × envelope bytes × gateways`. At the measured 500/s
with 100-byte envelopes, ten gateways cost 0.5 MB/s of Redis egress; at 5,000/s
with 1 KiB envelopes, ten gateways cost 50 MB/s, which is where a single Redis
node's network and single-threaded pub/sub delivery become the first bottleneck,
well before CPU on the gateways. The second cost is decode work: every gateway
JSON-parses every envelope, including those for scope keys it has no
subscribers for; the adapter checks local subscriptions before coalescing to
keep that cost to one parse. Presence is the third: every join or leave is a
handful of hash commands plus one envelope, so presence-heavy scope keys with
thousands of members turn `hgetall` into the hot command.

The intended mitigations, in order, are: shard the publication channel by
channel id (Redis 7 sharded pub/sub) so gateways subscribe only to channels
they host; keep presence counts as a separate hash of actor -> connection
count to avoid full-hash reads; and, beyond that, a dedicated broker.
Recording those as follow-ups is deliberate; none of them changes the kernel
contract.

## Consequences

- Publications are visible in the graph, the manifest, and impact analysis,
  and cannot cross a tenant boundary without an authentic capability.
- One resolver authenticates HTTP and realtime; policy lives on the channel.
- Adapters compete on the same conformance suite; the transport is a package
  choice, not a kernel commitment.
- Delivery is at-most-once with ordering per `(channel, scopeKey)` inside one
  gateway process; clients must tolerate gaps and `seq` resets, as the wire
  document states.
- Transactional publishes wait for the outbox composition; until then a
  transactional operation cannot publish, by design.
- Socket.IO cannot carry a custom disconnect reason; the slow-subscriber
  disconnect surfaces as `io server disconnect` and is documented as such.

## Rejected alternatives

### Rooms and namespaces as the declaration model

Rejected because rooms are a transport concept with no schema, no
authorization policy, and no place in the graph or manifest.

### A second authentication path for sockets

Rejected because it would diverge from ADR-0004 and double the credential
attack surface.

### A single `publish(channel, scopeKey, payload)` capability injected once

Rejected because the executor cannot tell which operation is calling, so an
operation could publish to channels it never declared. A per-channel
publication token makes the declaration and the binding one and the same, in
the shape ADR-0010 already uses for effects.

### An after-commit hook in the kernel for transactional publishes

Rejected for the reasons ADR-0010 gives for `afterCommit()`: it disappears on
process failure and offers no durable delivery contract. The outbox already
exists for exactly this.

### `@socket.io/redis-adapter` room fan-out for delivery

Rejected as the delivery path because the publication stream already reaches
every gateway; attaching it would double Redis traffic and duplicate
deliveries. It remains attachable by consumers for their own broadcasts.

## Addendum 2026-09-18: outbox composition

The composition §9 deferred has landed; the accepted text above is unchanged
and this section records what was built and the guarantees it carries.

### What was built

- `defineRealtimePublicationOutbox(channels, { retention? })` declares the
  framework-owned outbox `ship-realtime.publication` with one intent per
  channel, keyed by the channel id and bound to that channel's `publication`
  token. The intent payload is `{ scopeKey, payload }`: the scope key derived
  from an authentic scope when the intent was recorded and the payload already
  validated by the channel schema.
- A `transaction: "write"` operation that declares `publishes` and binds
  `channel.publication` receives a publisher whose `publish(scope, payload,
  { dedupeKey? })` validates scope and payload exactly like the immediate
  path, then records the intent through the operation's unit of work. The
  executor makes that substitution; the handler code is the same as on a
  `transaction: "none"` operation.
- `defineRealtimePublicationDispatcher(outbox, options)` generates
  `ship-realtime.publication.dispatch` (a `transaction: "none"`,
  `systemAccess()` operation that binds every channel's immediate publication
  token and declares `publishes` for all of them) plus the dead-letter
  management operations. `defineRealtimePublicationModule({ channels,
  realtime, outbox, retention?, ... })` mounts the outbox writer, one
  `channelPublisherProvider` per listed channel, the dispatcher and the
  cleanup operation as module `ship-realtime`, so a consumer only declares
  `publishes` and imports the module.
- Compile diagnostics: a write publisher without the mounted module, or with
  a channel the module does not list, is
  `SHIP_OPERATION_PUBLISH_DISPATCHER_MISSING`. A `transaction: "read"`
  publisher remains `SHIP_OPERATION_PUBLISH_TRANSACTION_FORBIDDEN`, because a
  read-only transaction cannot record an intent. The immediate path on
  `transaction: "none"` is unchanged.
- Graph and manifest: `publishes` is unchanged for clients; each publishing
  operation node carries `publicationDelivery: "immediate" | "outbox"`, and
  the dispatcher appears among every channel's `publishers`.

### Guarantees

- **Eventual delivery.** A publication recorded by a write operation is
  visible to subscribers only after the transaction commits and the
  dispatcher performs it. Between commit and dispatch a subscriber has not
  seen the event; dispatcher lag is the delivery delay.
- **At-least-once.** Delivery inherits ADR-0014's contract: a dispatcher that
  crashes after the backend accepted the publication but before completion
  is recorded leaves the record claimed, the lease expires and another
  dispatcher publishes it again. A subscriber may therefore see one
  publication twice. `dedupeKey` suppresses duplicate *intents* within the
  retention window (a retried write recording the same event twice); it does
  not make delivery exactly-once.
- **Ordering.** Intents are dispatched in `availableAt` order per batch;
  `seq` is still assigned by the delivering gateway. Clients keep the same
  tolerance for gaps and resets the wire document requires.

### Evidence

`packages/realtime-socketio/src/publication-outbox.integration.test.ts` (real
PostgreSQL through `ship-drizzle`, `redis:7-alpine`, an in-process Socket.IO
gateway and a `socket.io-client` subscriber) proves: a committed intent
reaches the subscriber only once dispatched; a rolled-back write leaves no
intent and delivers nothing; a replacement process dispatches an intent the
first process committed before dying; two publishes sharing a `dedupeKey`
deliver once. The customized golden consumer publishes `reports.requested`
from its `transaction: "write"` report request through this path.

## Addendum 2026-09-18: realtime refinements

This addendum records framework improvements to presence, publication bridges,
error handling, runners, and contract projection.

### Presence answers "is this actor online" cluster-wide

The proof needed a yes/no for one actor and had only `snapshot`, which reads
every member. `RealtimePresence` gains
`actorOnline({ channelId, scopeKey, actorId, actor, requestId })`, answering
`{ ok: true, online }` when the actor holds at least one live subscription to
the scope key on any gateway sharing the backend. A multi-connection actor is
online once and offline only after its last connection closes, the same rule
`joined`/`left` follow. The query is gated by the channel's subscription
authorization like `snapshot`; the actor asked about need not be the caller.
The Redis adapter reads the same membership hash presence already keeps; the
in-memory backend keeps the semantics process-locally; the conformance suite
asserts both. On the wire it is `ship:presence.online`.

### Presence snapshots are paged, with a declared overflow rule

A scope key with thousands of members returned an unbounded array, against
program rule 8. `snapshot` now takes `{ cursor?, limit? }` and returns
`{ count, actorIds, nextCursor? }`: `count` is the whole membership,
`actorIds` is one sorted page of at most `limit` members (default
`REALTIME_PRESENCE_DEFAULT_LIMIT`, 100; clamped to
`REALTIME_PRESENCE_MAX_LIMIT`, 1,000; never honoured above it), and
`nextCursor` is present exactly when members follow. The cursor is the last
actor id of the page, so a boundary stays stable while members join or leave;
callers treat it as opaque. A non-positive or non-integer `limit`, or a
non-string cursor, is `page-invalid` (`INVALID_PAGE` on the wire). The unpaged
call keeps working and returns the first default page. `pagePresenceMembers`
is the kernel helper every backend pages through, so the in-memory backend and
the Socket.IO adapter cannot diverge; the conformance suite asserts paging.

### Publishers are derived, never hand-mapped

The consumer's legacy bridge had built a map from channel id to publication
dependency by hand. `createChannelPublisherRegistry(channels | { modules },
backend)` derives it from the declarations themselves, a compiled application
included: `get(id)`, `has(id)`, `for(channel)` (typed) and
`publish(id, scope, payload)` (erased, validated at runtime), plus the
`providers` that bind every publication token. `defineRealtimePublicationModule`
now builds its publishers through the registry and exposes it as
`module.publishers`, sharing the very instances it provides, so a bridge
publishes through the backend the application was composed with.

### Erased publishers with a typed narrowing path

`ChannelPublisher<TChannel>` could not be held generically. `AnyChannelPublisher`
is the erased shape every typed publisher is assignable to; its `publish`
accepts either scope kind and any payload and validates both against the
channel declaration at runtime, so the erased path is exactly as safe as the
typed one minus the compile-time check. `narrowChannelPublisher(publisher,
channel)` restores the typed publisher and refuses a publisher created for
another declaration, even one sharing the id, so a bridge cannot publish one
channel's shape under another channel's type. `isChannelPublisher` guards.

### `executor.tryRun()` for call sites without an error path

PR #144 settled that `run()` throws a typed `OperationExecutionError` for
framework defects and infrastructure faults (an unexpected handler throw, a
provider that failed to initialize, an undeclared error, an abort) while every
declared outcome is a result. That stands: those errors belong on the caller's
error path, and the HTTP adapter's error path maps them to the `500
INTERNAL_SERVER_ERROR` envelope. The proof's gap was a legacy bridge with no
error path of its own that had to answer every call with a result. The
smallest consistent fix is a second method rather than a change to `run()` or
documentation alone: `executor.tryRun()` returns exactly what `run()` returns
and, where `run()` would throw, an `OperationExecutionFailure`: the adapter's
500 envelope (`details: { code, operationId }`, no cause) plus `cause`, the
original `OperationExecutionError`, for logging. A foreign throw (not an
execution error) still escapes. A request id is settled before the run so the
envelope and the result agree on it. Documentation alone was rejected because
it would have had every bridge reimplement the adapter's mapping;
changing `run()` was rejected because it would silently downgrade defects to
results for every caller.

### A framework-owned dispatch runner

The publication outbox had a dispatcher operation but no process that runs it
unless the consumer adopted jobs. `dispatchRealtimePublications(executor)` is
the one dispatch pass, and two runners call it. `startRealtimePublicationRunner(executor,
{ intervalMs, maxPassesPerCycle, backoff, observer, onError })` polls on an
interval, drains a backlog in bounded bursts (a non-empty pass is followed by
another at once, at most `maxPassesPerCycle` times before yielding to the
interval so a backlog cannot starve `stop()`), backs off on failure with the
outbox backoff shape, serializes `runOnce()` with the loop, and stops after
the in-flight pass. `defineRealtimePublicationDispatchJob({ trigger,
executor })` is the jobs-backed runner: a declared single-runner job whose
every run is the same pass, so adopting jobs later changes the schedule and
lease, not delivery. `@sixthsummit/ship-realtime-socketio` supplies
`createPublicationRunnerMetrics()` as the runner observer with
`ship.realtime.publication.runs{outcome}`, `ship.realtime.publication.run.duration`
and `ship.realtime.publication.records{result}`, shaped like the `ship.job.*`
instruments. The kernel keeps no OpenTelemetry dependency; the observer seam
is how it stays that way.

### Channel payload projection is visible in the types and the graph

The manifest already derives a channel's JSON Schema from its declared schema
exactly as it does an operation output (declared `~ship.contract` metadata
first, then the vendor's own projection for Zod v4); the consumer had wrapped
every payload in `contractSchema()` with hand-written JSON Schema because
nothing said which schemas qualify, and an unqualified one failed at manifest
build time. The kernel now names the convention: `ProjectableRuntimeSchema`,
`CONTRACT_SCHEMA_METADATA_KEY`, `NATIVELY_PROJECTED_SCHEMA_VENDORS` and
`isManifestProjectable`. Compilation warns
`SHIP_CHANNEL_PAYLOAD_UNPROJECTABLE` for a channel whose payload is neither,
and the graph carries `payload.projectable`. Modules keep their `channels`
typed per module (two `defineModule` overloads so an omitted `channels` stays
the empty tuple even under `defineApp`'s contextual type), which lets
`ApplicationContractOf<typeof app>` gain `channels: { [id]: { scope,
payload, presence } }`; a payload the manifest cannot project types as
`ChannelPayloadNotProjectable<id>` there, so the gap fails type-checking at
the first client use instead of the manifest build. The customized golden
consumer now declares its channel payloads as plain Zod schemas.

### Evidence

`packages/testing/src/realtime.ts` (conformance: paging, `actorOnline`, gating)
runs against the in-memory backend, the Socket.IO adapter over the memory
Redis hub and the raw-WebSocket smoke fixture; `gateway.test.ts` covers the
wire; `realtime.test.ts` and `realtime-publication.test.ts` cover the
registry, narrowing, the runner (bursts, backoff, stop, `runOnce`) and the
dispatch job; `executor.test.ts` covers `tryRun`; the customized golden
consumer's `bridge.ts` publishes by id and by narrowed type, answers with
`tryRun`, runs the dispatcher through the standalone runner, projects plain
Zod channel payloads and pages presence.

## Addendum 2026-09-18: the publication runner shares the adaptive outbox loop (SAPI-114)

The accepted text above is unchanged. `startRealtimePublicationRunner` is now
the kernel's shared outbox dispatch loop (`startOutboxDispatchRunner`, see the
[ADR-0014 addendum](./0014-actor-kinds-and-durable-outbox-delivery.md#addendum-2026-09-18-claim-cost-under-a-backlog-and-the-adaptive-dispatch-runner-sapi-114))
driving `ship-realtime.publication.dispatch`. One behaviour changed: a pass
that claimed records but fewer than the batch size used to be followed by
another pass at once and now waits `intervalMs`, because a short batch means
the backlog is drained; a full batch is still followed at once, at most
`maxPassesPerCycle` times before yielding to the interval. `runOnce()`,
`stop()`, the backoff, the observer seam and
`createPublicationRunnerMetrics()` are unchanged; the runner's `kind` stays
`ship.realtime-publication-runner`, and `RealtimePublicationRunnerPass` and
`RealtimePublicationRunnerObserver` are now aliases of
`OutboxDispatchRunnerPass` and `OutboxDispatchRunnerObserver`.
`dispatchRealtimePublications` returns `batchSize` with the counts.
`defineRealtimePublicationOutbox` and `defineRealtimePublicationModule` accept
`expectedRatePerSecond`, and `defineRealtimePublicationDispatcher` and the
module accept `roundsPerSecond`, so a publication outbox can be checked
against its declared dispatch capacity like any other.
