# `@sixthsummit/ship-realtime-socketio`

Socket.IO + Redis gateway for realtime channels declared with
`@sixthsummit/ship-core` (`defineChannel`, ADR-0017). The kernel owns the
channel declarations, the publication effect tokens, and subscription
authorization; this package owns the transport: handshake authentication
through the application's own credential adapter and actor resolver, the v1
wire protocol on the `/ship` namespace, cross-process fan-out over Redis
pub/sub, Redis-backed presence, coalescing, bounded per-connection send
buffers, control-message limits, and OpenTelemetry metrics.

The wire protocol is documented in `docs/v4/realtime.md`.

## API process

```ts
import { channelPublisherProviders } from "@sixthsummit/ship-core";
import { createRealtimePublisher } from "@sixthsummit/ship-realtime-socketio";

const realtime = createRealtimePublisher({ redis: { url: process.env.REDIS_URL } , channels });
// bind channel publications in the module that owns each channel
const providers = channelPublisherProviders(realtime, channels);
```

`publish()` validates the payload, enqueues the envelope locally, and returns.
Acceptance is not delivery.

## Gateway process

```ts
import { createRealtimeGateway } from "@sixthsummit/ship-realtime-socketio";

const gateway = createRealtimeGateway({
  channels: app,                          // compiled application or channel list
  auth: { credentials, actors },          // the same adapter + resolver the HTTP adapter uses
  redis: { url: process.env.REDIS_URL },
  tenantScopes,                           // required for tenant channels
  limits: { sendBufferHighWaterMark: 1_000, maxSubscriptionsPerConnection: 100 },
});
await gateway.listen(4000);
```

Several gateway processes may share one Redis; each delivers only to its own
connections and sweeps presence left behind by a crashed peer. Presence
snapshots are paged (`cursor`/`limit`/`nextCursor`) and `ship:presence.online`
answers whether one actor is connected anywhere.

## Dispatching durable publications

```ts
import { startRealtimePublicationRunner } from "@sixthsummit/ship-core";
import { createPublicationRunnerMetrics } from "@sixthsummit/ship-realtime-socketio";

const runner = startRealtimePublicationRunner(executor, {
  observer: createPublicationRunnerMetrics(), // ship.realtime.publication.* instruments
});
process.on("SIGTERM", () => void runner.stop());
```

Run one per process; the outbox lease keeps several processes from
dispatching the same intent twice. Applications that adopt jobs compose
`defineRealtimePublicationDispatchJob` over the same dispatch pass instead.

## Testing

`createMemoryRedisHub()` gives an in-process Redis stand-in so a publisher and
several gateways can be exercised without Docker. The backend passes
`realtimeBackendConformance()` from `@sixthsummit/ship-testing`.
