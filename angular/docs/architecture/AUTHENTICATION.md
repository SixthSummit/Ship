# Authentication

ShipAngular separates frontend identity/presentation from transport credentials.

## Frontend state

`AuthService` delegates to one `AuthAdapter` and exposes signals for state, initialization,
authentication, user, token, and optional capability availability.

`AuthState` is discriminated:

- `unknown` — initialization has not established an answer;
- `authenticated` — a user and optional frontend token are known;
- `unauthenticated` — absence of identity is authoritative;
- `indeterminate` — transport, protocol, provider, or operation failure prevented an
  authoritative answer; an optional previously confirmed user may be retained.

Never collapse `unknown` or `indeterminate` into signed out. In particular, a failed logout
must not claim an HttpOnly server session ended.

## Adapter capabilities

An adapter exposes `state`, `capabilities`, and optional explicit `initialize`/`destroy`.
Capabilities are discoverable before rendering or invoking them:

- password sign-in and optional registration;
- sign-out;
- bearer-token supply;
- email-link send/complete/recognize;
- popup sign-in.

Unsupported actions raise `AuthCapabilityUnavailableError`. Adapters must not hide network
I/O in constructors. Initialize them through `AuthService.initialize(signal)` and clean up
with `destroy` when appropriate.

## Firebase

`FirebaseAuthAdapter` remains available from `@sixthsummit/ship-angular/firebase-auth` and
uses the modular Firebase Auth API. Instantiate it inside Angular injection context. Provider UI/actions are
browser-only; guard them during SSR. Every built-in or third-party adapter must pass
`runConformance` from `/testing`.

## ShipAPI cookie sessions

Use `OperationSessionAuthAdapter` from `/auth`. It receives a structural operation client,
bindings for `me` and optional sign-in/register/sign-out/refresh operations, and an
application-specific user decoder. It constructs no URLs and performs no constructor I/O.

```ts
const session = new OperationSessionAuthAdapter({
  client,
  operations: {
    me: { operation: 'auth.me', input: () => ({}) },
    signIn: {
      operation: 'auth.login',
      input: credentials => ({ body: credentials }),
    },
    signOut: { operation: 'auth.logout', input: () => ({}) },
    refresh: { operation: 'auth.refresh', input: () => ({}) },
  },
  mapUser: value => decodeApplicationUser(value),
  getCsrfToken: signal => readCurrentCsrfToken(signal),
});

auth.setAdapter(session);
await auth.initialize();
```

The adapter's `credential` feeds the shared operation request policy. Cookie mode, CSRF,
and the optional refresh operation therefore follow the same origin, abort, idempotency,
and retry rules as other calls.

An identity operation returning `401` establishes `unauthenticated`. Other declared
failures and exceptional transport/protocol/provider failures establish `indeterminate`.

## Bearer credentials

For ShipAPI operation calls, use a bearer credential capability whose `getToken` runs for
each attempt. Do not capture a bootstrap token and do not rely on the root HttpClient
interceptor. A policy may request one explicit credential refresh after `401`; denial is
not a general retry condition.

The root `authInterceptor` remains for generic Angular `HttpClient` calls. It attaches a
current token only to relative URLs or exact origins in `API_ORIGINS`.

## Guards

`authGuard` and `noAuthGuard` are functional guards. They wait for initialization and use
the discriminated state. Every route is guarded or explicitly public according to the app's
lint policy.

## Security rules

- never log tokens, cookies, raw provider errors, or unredacted validation values;
- never put bearer credentials in query parameters or WebSocket URLs;
- forward only named SSR cookies/headers;
- reevaluate credentials for retries and socket reconnects;
- keep third-party origins outside ShipAPI credential policy;
- cancel outstanding auth work and suppress stale transitions.

See [operation auth](OPERATION_AUTH.md) and the [operation guide](OPERATION_CLIENT_GUIDE.md).
