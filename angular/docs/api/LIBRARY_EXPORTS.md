# Library entrypoints

Every entrypoint below is separately packaged. Import from the narrowest entrypoint so
optional capabilities do not enter unrelated browser bundles.

## `/operations`

Primary ShipAPI integration:

- contract selectors: `OperationId`, `InputOf`, `ErrorCodeOf`, transport-specific IDs;
- results: `OperationResultOf`, successes, failures, `ResponseMetadata`, `ShipError`;
- structural seam: `OperationClient`, `OperationExecutor`, call/execution options, including
  the opt-in per-call `keepalive` flag for final page-unload calls;
- Angular DI: `createShipClientToken`, `provideShipClient`, `injectShipClient`, and
  `provideShipOperationBoundary` for one client/policy factory whose
  `ShipOperationBoundaryConfig` tracks Angular pending tasks per call by default
  (`trackPendingTasks: false` opts out);
- SSR: `createShipClientContext` and explicit cookie/header forwarding rules;
- request policy: `createOperationRequestPolicy`, `createPolicyClient`,
  `createPolicyClientFromPolicy`, credential and operation-policy types;
- reactivity: `createOperationResource`, `createOperationMutation`;
- errors: API presentation, abort, timeout, protocol, transport, policy, concurrency, and
  rollback errors;
- wire helpers: error-envelope parsing, retry decisions, and response metadata.

```ts
import {
  createOperationResource,
  createShipClientToken,
  provideShipOperationBoundary,
  type OperationClient,
} from '@sixthsummit/ship-angular/operations';
```

## `/ship-api`

`createShipApiClientExecutor` adapts ShipAPI's browser-safe `ClientContract` manifest and
structural HTTP client to the normalized `/operations` executor. It validates runtime
statuses and metadata, retains errors/additive fields, and isolates construction-time
credential modes. Its JavaScript is import-free; the public type boundary uses the
optional `@sixthsummit/ship-contract` peer. Applications provide the structural
client factory.

Keeping this bridge separate means generic operation clients and third-party structural
implementations do not pay for ShipAPI-specific result normalization.

## `/auth`

`OperationSessionAuthAdapter` binds frontend identity/session actions to typed operations.
Its configuration declares operation IDs and response-to-user mapping. Credential supply
for the transport pipeline remains in `/operations`.

## `/firebase-auth`

`FirebaseAuthAdapter` is isolated here with optional `@angular/fire` and `firebase` peers.
Applications that do not use Firebase never load those runtimes through the root bundle.

## `/forms`

`defineOperationForm` and `createOperationForm` create typed controls from client-safe
operation-body definitions. Built-in codecs cover identity values, ISO dates, and bigint
strings. Stable validation issues carry string/number paths, machine codes, and safe
messages without importing Drizzle or server schemas.

## `/upload`

- `createOperationUpload` — multipart constraints, XHR progress, cancellation, shared
  prepared request policy, and typed JSON results;
- `createOperationSignedUpload` — explicit sign/provider-transfer/complete lifecycle;
- validation/provider error types.

## `/download`

`createOperationDownload` preserves exact bytes, status, metadata, MIME, disposition, and
filename; it distinguishes JSON error envelopes from binary success and supports Blob,
ArrayBuffer, and stream representations.

## `/stream`

- `createStream` implements the canonical streaming response mode: given a manifest
  operation declared `response.mode: "stream"`, it infers frame/terminal types, builds the
  request from the declared method/path, branches on `Content-Type` for pre-first-frame
  error envelopes, parses `frame` / `terminal` / `error` events with `id:` sequence
  tracking, ignores heartbeat comments, and exposes `frames`, `latest`, `terminal`,
  `status`, `error`, `seq`, and `abort()` as signals. It opens no request under SSR. See
  [ADR 0004](../architecture/decisions/0004-streaming-response-mode.md);
- `createOperationStream` and `parseSseFrames` implement typed SSE/chunked streams with
  abort, sticky IDs, bounded retention, terminal reasons, and contract-approved reconnect;
- `resolveShipStreamOperation`, `ShipStreamManifest`, `StreamFrameOf`, and
  `StreamTerminalOf` expose the manifest projection and its type selectors.

## `/socket`

`createOperationSocket` provides typed messages, protocol/ticket binding, bounded history,
explicit send results, reconnect policy, close information, cancellation, and SSR inertness.

## `/realtime`

`provideShipRealtime`, `injectRealtime`, and `createShipRealtime` implement declared realtime
publication: subscriptions typed from the manifest's `channels`, `latest` / `events` / `presence`
/ `dropped` / `status` signals, reconnect with backoff and resubscribe-all, credential refresh on
every attempt, ack timeouts, and an SSR no-op. `ShipRealtimeTransport` is the adapter boundary;
`createSocketIoTransport` is the first implementation and makes `socket.io-client` an optional
peer of this entry alone. See [Realtime Subscriptions](../guides/REALTIME_SUBSCRIPTIONS.md).

## `/testing`

- `runConformance` and `MockAuthAdapter` for the frontend `AuthAdapter` contract;
- `assertOperationClientConformance` for runner-independent structural-client runtime
  checks.

## `/eslint`

The packaged flat-config plugin exports the `use-inject`, `onpush-required`,
`route-guard-or-public`, and `no-rxjs-in-public-api` rules. Generated applications register
them alongside Angular ESLint; this is tooling-only and never enters a browser bundle.

## `/hono-v4`

Temporary compatibility only: `HonoV4ClientAdapter` plus capability diagnostics/errors.
The consuming application supplies the route mapping; ShipAngular has no Hono dependency.

## `/legacy-rest`

Temporary compatibility only: `LegacyRestClientAdapter` maps a stable operation ID to an
application-owned URL/method/serialization request. The request returns a native `Response`,
so the adapter retains status, metadata, declared/unknown errors, and protocol failures rather
than inheriting a legacy message-only `Promise<T>` boundary. Use it behind the shared policy
client; binary and long-lived protocols stay in their dedicated capability entrypoints.

## Root entrypoint

The root package retains current Angular-facing APIs:

- `AuthService`, frontend `AuthAdapter` types, and guards;
- generic REST `ApiClient`, `createResource`, HTTP errors and interceptors;
- legacy Hono provider/fetch wrappers and legacy upload/stream/socket APIs;
- `createSchemaForm`/Zod compatibility;
- `OnlineService`, pipes, `Logger`, `defineEnv`, common types, and `VERSION`.

This is a compatibility surface. New ShipAPI work belongs in the explicit secondary
entrypoints. Third-party REST may continue using the root REST APIs.

## Error rule

Operation calls never turn declared application failures into message-only exceptions.
Keep status, durable code, unknown details, response metadata, and request ID. Only adapt a
failure to `OperationApiError` at an exception-oriented presentation boundary.

## `/query`

Optional TanStack Query integration for reads, mutations, infinite queries,
actor/tenant-scoped cache identity, and SSR hydration. Install the exact optional
peer version declared in the package manifest. See the
[TanStack Query guide](../guides/TANSTACK_QUERY.md); this entrypoint is pending
release on `dev` and is not part of the previously released 4.1.0 package.

## `/push`

Optional Web Push: `provideShipPush`, `injectPush`, `SHIP_PUSH`, `ShipPush`,
`ShipPushOptions`, `ShipPushSubscription`, `PushNotificationClick`, and redacted
`ShipPushError`/`ShipPushErrorCode`. Requires Angular's optional service-worker peer
and an application-owned PWA setup. See [Web Push](../guides/WEB_PUSH.md).
