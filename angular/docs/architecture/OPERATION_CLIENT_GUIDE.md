# Operation client guide

This is the target ShipAngular ↔ ShipAPI integration. It is implemented on the redesign
branch, but the real ShipAPI packed artifact and client-site rollout gates are still pending.

## Boundary

The current ShipAPI redesign exposes a browser-safe `/contract` runtime and emits a
deterministic JSON manifest. The remaining packaging step is an application-specific,
browser-only contract type artifact. The intended application boundary therefore has:

1. an application contract keyed by stable operation IDs; and
2. a shared structural client runtime that understands the graph's URLs, methods,
   serialization, codecs, and response decoding.

ShipAngular does not import ShipAPI runtime code or a composed Hono app. It adds Angular
DI, resources/mutations, request-scoped SSR context, credential policy, and presentation
adaptation around the structural client.

## Generate the app token/provider

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@acme/ship-contract \
  --contractType=AppContract \
  --cookieNames=session \
  --headerNames=x-request-id,accept-language
```

After the provider exists, generate contract-typed read and mutation wrappers without recreating
transport details in application code:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:operation-resource account-detail \
  --operationId=accounts.get
pnpm exec ng generate @sixthsummit/ship-angular:operation-mutation create-account \
  --operationId=accounts.create
```

The resource wrapper accepts a signal-tracked input factory. The mutation wrapper exposes the full
mutation state machine, including typed declared failures, exceptional errors, cancellation, and
reset. Customize optimistic behavior deliberately at the generated call site; no generator infers
mutation safety from an HTTP verb.

Generated bindings also drive non-JSON and form scaffolds:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:download invoice \
  --operationId=invoices.pdf --bindingName=invoiceDownloadBinding
pnpm exec ng generate @sixthsummit/ship-angular:socket notifications \
  --bindingName=notificationsSocketBinding
pnpm exec ng generate @sixthsummit/ship-angular:signed-upload archive \
  --bindingName=archiveSignedUploadBinding
pnpm exec ng generate @sixthsummit/ship-angular:operation-form account \
  --bindingName=accountFormBinding
```

Socket and signed-upload factories require exact approved origins at creation time. The form
factory consumes only the client-safe generated binding. No generator reconstructs transport or
validation metadata in application code.

The generated `src/api.ts` exports client and request-policy tokens, one boundary provider,
and typed injectors. Register ShipAPI's structural client through ShipAngular's import-free
adapter in `app.config.ts`:

```ts
import { createHttpOperationClient } from '@sixthsummit/ship-api/contract';
import { clientContract, type AppContract } from '@acme/ship-contract';
import {
  createOperationRequestPolicy,
  createPolicyClientFromPolicy,
} from '@sixthsummit/ship-angular/operations';
import { createShipApiClientExecutor } from '@sixthsummit/ship-angular/ship-api';

provideAppShipClient(context => {
  const requestPolicy = createOperationRequestPolicy<AppContract>({
    policies: operationPolicies,
    baseHeaders: context.forwardedHeaders,
    allowedOrigins: [new URL(context.apiBaseUrl).origin],
    credentials: currentCredentialCapability,
    requestId: { generate: () => crypto.randomUUID() },
  });
  const executor = createShipApiClientExecutor<AppContract>(clientContract, ({ credentials }) =>
    createHttpOperationClient<AppContract>(clientContract, {
      baseUrl: context.apiBaseUrl,
      fetch: globalThis.fetch,
      credentials,
    })
  );
  return {
    requestPolicy,
    client: createPolicyClientFromPolicy(executor, requestPolicy, {
      targetUrl: context.apiBaseUrl,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  };
});
```

`createShipApiClientExecutor` deliberately imports no ShipAPI runtime. It adapts the
current ShipAPI client's top-level request ID and `metadata` object into ShipAngular's
lossless result, checks success statuses against the manifest, and retains unknown additive
error fields. ShipAPI currently selects `credentials` when constructing a client, so the
adapter creates at most one client per credential mode; anonymous and cookie calls cannot
share construction-time credential state.

The important stable contracts are `OperationClient<AppContract>` and
`OperationRequestPolicy<AppContract>`. Unary and non-JSON transports receive the same
policy instance. Until ShipAPI projects request policy, `operationPolicies` is an
application-owned checked mapping; it must not infer retry safety from the HTTP method.

The Angular provider creates one client per injector. During SSR, Angular's request
injector receives a sanitized context containing only allowlisted cookies/headers and the
incoming request's abort signal. Never store that context in a process singleton.

### Application stability

`provideShipOperationBoundary` registers an Angular `PendingTasks` task for the whole
duration of every unary operation call, including credential supply, retries, and the one
permitted auth refresh, and releases it in `finally` when the call resolves, rejects, times
out, or aborts. `ApplicationRef.whenStable()`, SSR serialization, hydration, and test
harnesses therefore wait for in-flight operations exactly as they wait for `HttpClient`.
Stream and socket subscriptions are long-lived and are not tracked.

Pass `trackPendingTasks: false` in the boundary config to opt out, for example when an
application deliberately renders before background operations settle:

```ts
provideShipOperationBoundary(APP_SHIP_CLIENT, APP_SHIP_REQUEST_POLICY, factory, {
  apiBaseUrl,
  trackPendingTasks: false,
});
```

## Reads

```ts
readonly accountId = input.required<string>();
private readonly client = injectAppShipClient();

readonly account = createOperationResource(
  this.client,
  'accounts.get',
  () => ({ params: { accountId: this.accountId() } }),
  { etag: { key: input => input.params.accountId } },
);
```

Signals read in the input factory are tracked. Angular aborts superseded loads; the
operation signal reaches the client. The resource exposes:

- `value()` for current typed data;
- `result()` for the full lossless result;
- `failure()` for declared API failure values;
- `metadata()` for response metadata;
- `error()` for exceptional failures;
- `status()`, `isLoading()`, `reload()`, and `destroy()`.

With ETags enabled, `304` restores the prior typed value. A `304` without a cache entry is
a protocol error.

## Mutations

```ts
readonly updateAccount = createOperationMutation(this.client, 'accounts.update', {
  concurrency: 'reject',
  call: input => ({ idempotencyKey: stableKeyFor(input) }),
});

const result = await this.updateAccount.execute({
  params: { accountId },
  body: changes,
});

if (!result.ok) {
  switch (result.error.code) {
    case 'ACCOUNT_NOT_FOUND':
      // expected application outcome
      break;
  }
}
```

A final heartbeat or completion call issued from `pagehide` or a hidden tab can opt in to
fetch `keepalive` per call. The flag reaches the structural client on every attempt,
including approved retries, and is never set by default:

```ts
readonly completeSession = createOperationMutation(this.client, 'sessions.complete', {
  call: input => ({ idempotencyKey: input.params.sessionId, keepalive: true }),
});
```

Browsers cap keepalive request bodies at 64 KiB; the client does not enforce that limit, so
keep unload payloads small. Any `OperationClient.call` accepts the same option directly.

The default rejects overlapping execution. `take-latest` cancels the older call but cannot
be combined with optimistic updates. Optimistic policies must define apply and rollback;
reconcile is optional. Rollback failures retain both the primary and rollback error.

## Request policy

Create one `OperationRequestPolicy`, then wrap ShipAPI's generated executor with
`createPolicyClientFromPolicy`. Supply the operation policy map emitted from the graph and
one credential capability:

- `anonymous`;
- `bearer`, whose token supplier runs on every attempt; or
- `cookie`, with an optional current CSRF-token supplier.

The policy rejects caller-written sensitive headers, limits credentials to allowed origins,
creates request IDs, composes cancellation/timeout, permits at most one declared auth
refresh, and retries only contract-approved operations. Unsafe retries require supported
idempotency and a stable key. `Retry-After` is retained and used by approved retries.

## Failures

Declared failures resolve as:

```ts
{
  ok: false,
  status: 404,
  error: { code: 'ACCOUNT_NOT_FOUND', message: '...', details, requestId },
  headers: metadata,
}
```

Switch on `error.code`, never message text. Unknown error codes/details and additive fields
are retained. `OperationApiError` is the lossless presentation adapter for an
exception-oriented boundary. `TransportError`, `ProtocolError`, `OperationTimeoutError`,
and `OperationAbortedError` remain distinct exceptions.

## Non-JSON capabilities

Use their dedicated entrypoints:

- `/upload` for multipart progress, cancellation, constraints, and signed transfers;
- `/download` for exact bytes, filename/disposition, and JSON-error discrimination;
- `/stream` for typed SSE/chunked events, sticky IDs, bounded retention, and reconnect;
- `/socket` for typed messages, protocols, bounded history, tickets, and SSR inertness;
- `/forms` for client-safe operation-body fields/codecs and stable validation issues.

All capabilities consume prepared shared policy; they must not manually assemble auth
headers or leak credentials to provider origins.

## Third-party REST and Hono v4

Third-party REST remains on the root `ApiClient`/`createResource` surface and Angular
interceptors. It must not inherit ShipAPI credentials or generated serialization.

Pinned Hono v4 applications use `/hono-v4` temporarily. The application-owned mapping is
the only place that knows route-tree properties. See
[`HONO_V4_COMPATIBILITY.md`](HONO_V4_COMPATIBILITY.md).

## Verification

Run unit/type/build/coverage plus `pnpm test:packed-conformance` and
`pnpm test:browser-conformance`. The coordinated gate is:

```bash
pnpm test:joint-conformance -- --manifest /path/to/shipapi-artifacts.json
```

It deliberately fails rather than skipping when real ShipAPI artifacts are absent.
The current cross-repository gaps and proposed defaults are recorded in
[`SHIPAPI_INTEGRATION_FEEDBACK.md`](SHIPAPI_INTEGRATION_FEEDBACK.md).

## Transport lifecycle guarantees

Downloads reject redirects, including redirects to another approved origin. Generated download
bindings must name the final URL so credential policy can approve it before any bytes are sent.
In `stream` mode, `start()` returns the response and readable stream after headers arrive;
`pending()` stays true and `status()` stays `downloading` until the consumer reaches EOF.
Caller abort, timeout, `cancel()`, `reset()` and `destroy()` remain connected to the body.
Canceling the returned stream also ends the download. Always consume or cancel the stream.

WebSocket decoding or subprotocol failures close the connection using application code `4002`.
A binding may override this with `1000` or an integer from `3000` through `4999`, the codes
browser JavaScript can send. Reserved protocol codes such as `1002` are rejected at creation.
The public `close()` method validates the code and its 123-byte UTF-8 reason before changing state.

Mutation call signals compose with helper cancellation and take-latest supersession. Socket
ticket call signals remain active through ticket acquisition. An automatic session refresh is
part of the operation requesting refresh and does not supersede its own initialization.
