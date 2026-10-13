# ADR 0005: Declared realtime publication

- **Status:** Accepted for the client half (ShipAngular `./realtime`, SAPI-109)
- **Date:** 2026-09-18
- **Deciders:** ShipAngular and ShipAPI maintainers
- **Related:** ADR 0002, and ShipAPI's realtime gateway (SAPI-109)

## Context

ShipAngular already ships two per-operation transports: `/stream` for a declared SSE
response and `/socket` for a single bounded WebSocket bound to one `socket` transport
operation. Neither expresses server-initiated fan-out: several viewers of the same
resource receiving the same published event, with membership, without each of them
owning a bespoke socket operation.

The alternative to a declared surface is an ad-hoc topic string. That moves authorization
into whatever string the browser happens to send and makes the publication surface
invisible to the manifest, to codegen, and to the joint conformance gate. It is the same
mistake the operation-client rebuild removed from HTTP.

## Decision

Realtime publication is **declared by the ShipAPI manifest** and projected
transport-neutrally:

- `channels: { [channelId]: { scope, payload, presence } }`, with `scope` one of
  `actor` / `tenant` / `resource`;
- `operations[id].publishes: string[]`, naming declared channel ids.

The manifest contains no rooms, namespaces, or other transport detail. ShipAngular's
`./realtime` entry types every subscription from `channels` and refuses, without reaching
the wire, any channel the manifest does not declare.

The canonical wire protocol — the `/ship` namespace, `auth.credential`, the three
client-to-server events with their acks and error codes, and the `ship:event` /
`ship:presence` / `ship:dropped` server events — is implemented verbatim by both repos
and exercised by a Socket.IO fixture gateway in
`conformance/browser/realtime-fixture-server.mjs`.

**Socket.IO is the first transport, not the contract.** Both production consumers already
ship `socket.io-client`, so it is added as an _optional peer dependency of the `./realtime`
entry only_; the root entry never imports it and the bundle gate proves consumers who do
not use realtime pay nothing. The adapter is loaded lazily and sits behind
`ShipRealtimeTransport`. Nothing Socket.IO-shaped appears in the public subscription API
beyond the transport option itself, so a raw-WebSocket adapter can replace it without a
breaking change.

Reconnect, exponential backoff, credential refresh, resubscribe-all, and ack timeouts are
owned by the client rather than the transport, so every adapter behaves identically. The
provider is a no-op under SSR: `subscribe()` returns a closed subscription and no socket
is opened.

## Consequences

- The publication surface is reviewable in the manifest and covered by the same conformance
  gates as HTTP operations.
- Presence ships in v1, but only for channels that declare it; the `presence` signal is
  absent at the type level otherwise.
- `seq` is per `(channel, scopeKey)` and monotonic only within one gateway process. Clients
  must tolerate gaps and resets, so it is not a durable cursor. Applications refetch through
  the HTTP operation when `dropped` grows.
- Refused subscriptions are terminal for that subscription object rather than retried, which
  keeps a forbidden subscription from becoming a reconnect loop.
- `/realtime` does not replace `/stream` or `/socket`; those remain the per-operation
  transports.
