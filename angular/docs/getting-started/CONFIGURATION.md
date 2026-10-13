# Configuration

## Environment

The generated app uses Angular environment replacements. Keep the API origin absolute and
credential-free so the same value is safe during browser and SSR construction:

```ts
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost:3000/v1',
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    appId: '',
  },
};
```

Never place server secrets, Firebase Admin credentials, private provider keys, cookies, or
bearer tokens in environment files shipped to the browser. `defineEnv()` is available for
validated client configuration, but schema validation does not make a secret safe.

## ShipAPI client

Generate `src/api.ts` from a packed client-safe contract:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:api-client \
  --contractPackage=@my-org/ship-api-contract \
  --contractType=AppContract \
  --cookieNames=session \
  --headerNames=x-request-id,accept-language
```

The output creates typed client and request-policy tokens. Register one boundary factory in
`app.config.ts`; it returns `{ client, requestPolicy }` so unary calls and non-JSON
capabilities use the same credentials and policy. Its concrete executor/binding imports come
from ShipAPI, but the factory must consume the sanitized context rather than a browser global
or raw SSR request.

Only listed cookies and headers are forwarded during SSR. Authorization, raw cookie,
set-cookie, CSRF, and idempotency headers cannot be forwarded through the general header
allowlist. Cookie names are selected individually.

## Authentication

Frontend identity state is configured through `AuthService` and an `AuthAdapter`. Transport
credentials use operation capabilities:

- bearer token supplier reads the current token per attempt;
- cookie policy chooses `credentials` and supplies CSRF only when required;
- anonymous operations omit credentials;
- one auth refresh happens only when the operation policy explicitly permits it.

Use the operation-backed session adapter from `/auth` for ShipAPI cookie sessions. Root
`authInterceptor` remains for third-party/generic `HttpClient` requests and must not be
duplicated for operation calls.

## Request policy

ShipAPI's generated policy projection configures operation authentication, safety,
idempotency, CSRF, and retries. The shared client policy also configures:

- exact allowed origins;
- base headers that contain no secrets;
- request-ID generation;
- timeout/cancellation;
- retry timing.

Unsafe operations cannot retry unless the contract permits idempotency and the caller
provides a stable key. Authentication/authorization denials are not general retry signals.

## Third-party REST

Register Angular `HttpClient` and functional interceptors for independent REST APIs. Use
`API_ORIGINS` to limit bearer attachment. Never add a third-party origin to the ShipAPI
credential policy merely to reuse a client.

## SSR

Each Angular SSR request needs its own injector/client context. Cancellation is inherited
from the incoming `Request.signal`. Code executed during SSR must not touch `window`,
`document`, storage, `WebSocket`, or browser-only auth SDKs without a platform guard.

Run a concurrent A/B SSR test that proves cookies, actors, request IDs, abort controllers,
and private cache values cannot cross requests.

## Verification

```bash
pnpm type-check
pnpm test:coverage
pnpm build:ssr
pnpm e2e
```

For framework/ShipAPI boundary changes also run the packed and joint conformance gates
described in the [operation guide](../architecture/OPERATION_CLIENT_GUIDE.md).
