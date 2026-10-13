# ShipAngular consumption

ShipAngular's target seam is the browser-safe structural `OperationClient`, not
Hono's server-derived `hc<typeof app>()` type.

```ts
interface OperationClient<TContract extends OperationTypeContract> {
  call<TId extends HttpOperationId<TContract>>(
    operationId: TId,
    input: OperationInput<TContract, TId>,
    options?: OperationCallOptions,
  ): Promise<OperationClientResult<TContract, TId>>;
}
```

`@sixthsummit/ship-contract` provides the default Fetch implementation.
ShipAngular owns Angular DI, signals/resources, SSR request scoping, auth-token
supply, and UI-facing error helpers around this interface.

## Contract ownership

ShipAPI emits a deterministic client-safe manifest and OpenAPI document from the
compiled backend graph. The frontend must not import Hono, Drizzle, PostgreSQL,
Firebase Admin, Node telemetry, or a server application module at runtime.

The final generated application-specific TypeScript contract package is a joint
ShipAPI/ShipAngular decision. Until its format and ownership pass the shared
fixture, do not replace it with handwritten frontend DTOs.

## Expected failures are values

```ts
const result = await client.call("accounts.read", {
  params: { accountId },
});

if (result.ok) {
  account.set(result.data);
} else if (result.error.code === "ACCOUNT_NOT_FOUND") {
  account.set(undefined);
}
```

Declared API and framework failures retain status, durable code, safe message,
details, request ID, headers, retry metadata, ETag, content type, and content
disposition. Network failure, cancellation, missing codecs, and malformed or
undeclared protocol responses remain exceptions.

ShipAngular may convert a failed result to a presentation-friendly `ApiError`
for a resource loader, but the low-level client must not reduce it to a
message-only exception.

## One transport pipeline

The operation client pipeline should own:

- current bearer or cookie credentials;
- CSRF and idempotency headers;
- request ID and approved tracing headers;
- `AbortSignal`, timeout, and conservative retry;
- `Retry-After`, ETag, and exposed response metadata; and
- safe protocol diagnostics.

Do not implement those concerns once in Angular `HttpClient` interceptors and
again in Fetch wrappers. Generic third-party REST may keep a separate
`HttpClient` path.

## SSR isolation

Create a request-scoped client or call context for SSR. Forward only approved
cookies and headers. Concurrent requests must not share credentials, actors,
abort controllers, or private cached results. Browser globals must not be read
during server rendering.

## Reactive resources

A likely target API is explicit rather than mode-probing:

```ts
const account = createOperationResource(client, "accounts.read", () => ({
  params: { accountId: accountId() },
}));
```

ShipAngular decides signal dependency tracking, cancellation, stale-response
suppression, reload, optimistic mutation, and error presentation. ShipAPI does
not generate Angular services, signals, guards, or forms.

## Uploads, downloads, and future transports

The shared fixture must separately prove multipart limits/auth/progress,
JSON-error-versus-binary-success, filename and disposition metadata, abort, SSR,
and CORS-exposed headers. Streaming responses and declared realtime publication
use their own focused contracts (ADRs 0016 and 0017); they are not unary JSON
operations.

## Compatibility window

Most current clients use route-first v4. ShipAngular should keep a temporary
`HonoV4ClientAdapter` behind the same frontend resource seam while new work uses
the operation client. The compatibility adapter is not the target interface and
must not constrain it to `hc()` semantics.

See the framework-owned joint fixture under `fixtures/joint-conformance/` and
ShipAngular's packed/browser conformance gates for integration evidence.
